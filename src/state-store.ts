/**
 * 基于数据目录 JSON 文件的状态存储（ADR-0006）。
 *
 * 每个 Bot Instance 一个文件：`<dataDir>/menu-edit/<encoded-appId>.json`。
 * 写入按 AppID 串行化，先写临时文件再原子替换主文件，并保留上一版为 `.bak`；
 * 主文件损坏时回退读取 `.bak`，两者都不可读则报错而不是静默覆盖。
 *
 * schemaVersion 1 的旧文件在读取时迁移到 2；读到未知的更高版本时抛错拒绝静默覆盖。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { panelItemScopes, withPanelItemScopes } from './command-panel'
import { isRecord } from './guards'
import { MENU_STATE_SCHEMA_VERSION, type MenuState } from './types'

export type MenuStateStoreErrorReason = 'state-unreadable' | 'state-write-failed' | 'state-version-unsupported'

export class MenuStateStoreError extends Error {
  constructor(
    public readonly reason: MenuStateStoreErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'MenuStateStoreError'
  }
}

export interface MenuStateStoreOptions {
  /** Koishi 数据目录，通常为 `<baseDir>/data`；状态文件落在其 `menu-edit/` 子目录下。 */
  dataDir: string
  /** 重命名遇到 Windows 偶发占用时的重试次数。 */
  renameRetries?: number
}

type ParseResult =
  | { kind: 'ok'; state: MenuState }
  | { kind: 'unsupported'; version: number }
  | { kind: 'invalid'; error?: unknown }

function isStateShape(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.appId !== 'string') return false
  if (typeof parsed.revision !== 'number' || !Number.isInteger(parsed.revision) || parsed.revision < 0) return false
  if (typeof parsed.updatedAt !== 'string') return false
  if (!isRecord(parsed.draft)) return false
  if (!isRecord(parsed.draft.privateMenu) || !isRecord(parsed.draft.commandPanel)) return false
  if (parsed.importedConfiguration !== null && !isRecord(parsed.importedConfiguration)) return false
  if (!isRecord(parsed.published)) return false
  if (parsed.published.privateMenu !== null && !isRecord(parsed.published.privateMenu)) return false
  if (!isRecord(parsed.published.commandPanels)) return false
  return true
}

/** v1 的 groupPanel 条目统一补 `scopes: ['group']`，让模型升级到 v2。 */
function migrateCommandPanelV1(value: unknown): Record<string, unknown> {
  const panel: Record<string, unknown> = isRecord(value) ? { ...value } : { remark: 'menu-edit', items: [] }
  const items = Array.isArray(panel.items) ? panel.items : []
  panel.items = items.map((item) => {
    const scopes = panelItemScopes(item)
    return withPanelItemScopes(item, scopes.length ? scopes : ['group'])
  })
  return panel
}

/** v1 的 published 面板是平台侧内容，条目不带本地 scopes，这里只补 items 数组。 */
function publishedPanelV1(value: unknown): Record<string, unknown> {
  const panel = isRecord(value) ? { ...value } : { remark: 'menu-edit', items: [] }
  panel.items = Array.isArray(panel.items) ? panel.items : []
  return panel
}
function migratePublishedV1(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const panelId = typeof value.panelId === 'string' ? value.panelId : ''
  if (!panelId) return {}
  return {
    group: {
      scope: 'group',
      panelId,
      panel: publishedPanelV1(value.panel),
      version: typeof value.version === 'number' ? value.version : null,
      publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : '',
      cleanup: isRecord(value.cleanup)
        ? {
            panelIds: Array.isArray(value.cleanup.panelIds) ? value.cleanup.panelIds : [],
            updatedAt: typeof value.cleanup.updatedAt === 'string' ? value.cleanup.updatedAt : null,
          }
        : { panelIds: [], updatedAt: null },
    },
  }
}

function migrateImportedV1(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const { groupPanel, ...rest } = value
  return {
    ...rest,
    commandPanel: migrateCommandPanelV1(groupPanel),
  }
}

/** 把 schemaVersion 1 的状态迁移到 2：groupPanel → commandPanel / commandPanels.group。 */
function migrateV1(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const draft = isRecord(parsed.draft) ? parsed.draft : {}
  const published = isRecord(parsed.published) ? parsed.published : {}
  const { groupPanel: draftGroupPanel, ...draftRest } = draft
  const { groupPanel: publishedGroupPanel, ...publishedRest } = published
  return {
    schemaVersion: MENU_STATE_SCHEMA_VERSION,
    appId: parsed.appId,
    revision: parsed.revision,
    updatedAt: parsed.updatedAt,
    importedConfiguration: migrateImportedV1(parsed.importedConfiguration),
    draft: {
      ...draftRest,
      privateMenu: isRecord(draft.privateMenu) ? draft.privateMenu : { items: [] },
      commandPanel: migrateCommandPanelV1(draftGroupPanel),
    },
    published: {
      ...publishedRest,
      privateMenu: isRecord(published.privateMenu) ? published.privateMenu : null,
      commandPanels: migratePublishedV1(publishedGroupPanel),
    },
  }
}

function parseState(raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { kind: 'invalid', error }
  }
  if (!isRecord(parsed)) return { kind: 'invalid' }
  if (typeof parsed.schemaVersion !== 'number') return { kind: 'invalid' }
  if (parsed.schemaVersion > MENU_STATE_SCHEMA_VERSION) {
    return { kind: 'unsupported', version: parsed.schemaVersion }
  }
  const migrated = parsed.schemaVersion === MENU_STATE_SCHEMA_VERSION ? parsed : migrateV1(parsed)
  if (!migrated || !isStateShape(migrated)) return { kind: 'invalid' }
  return { kind: 'ok', state: migrated as unknown as MenuState }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

interface ReadStateResult {
  state: MenuState | null
  missing: boolean
  unsupportedVersion?: number
  error?: unknown
}

async function readState(path: string): Promise<ReadStateResult> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    return { state: null, missing: isMissing(error), error }
  }
  const result = parseState(raw)
  if (result.kind === 'ok') return { state: result.state, missing: false }
  if (result.kind === 'unsupported') return { state: null, missing: false, unsupportedVersion: result.version }
  return { state: null, missing: false, error: result.error ?? new Error('状态文件结构非法') }
}

export class MenuStateStore {
  readonly root: string
  private readonly renameRetries: number
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(options: MenuStateStoreOptions) {
    this.root = join(options.dataDir, 'menu-edit')
    this.renameRetries = options.renameRetries ?? 3
  }

  /** 主文件路径，供诊断与测试定位，不参与业务逻辑。 */
  pathFor(appId: string): string {
    return join(this.root, `${encodeURIComponent(appId)}.json`)
  }

  /** 备份文件路径。 */
  backupPathFor(appId: string): string {
    return `${this.pathFor(appId)}.bak`
  }

  /**
   * 按 AppID 串行执行一段读改写操作。
   *
   * revision 校验必须在读取与写入之间保持互斥，否则两个并发保存都会读到同一个
   * revision 并先后写入，后一次会静默覆盖前一次。因此 MenuService 的读改写整体走这里。
   */
  runExclusive<T>(appId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(appId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(appId, tail)
    void tail.then(() => {
      if (this.queues.get(appId) === tail) this.queues.delete(appId)
    })
    return run
  }

  /** 读取状态；文件不存在返回 null，主文件损坏时回退 `.bak`。 */
  async read(appId: string): Promise<MenuState | null> {
    const primary = await readState(this.pathFor(appId))
    if (primary.state) return primary.state
    if (primary.unsupportedVersion !== undefined) {
      throw new MenuStateStoreError(
        'state-version-unsupported',
        `应用 ID ${appId} 的菜单状态文件版本 ${primary.unsupportedVersion} 高于当前支持版本 ${MENU_STATE_SCHEMA_VERSION}，拒绝静默覆盖。`,
      )
    }
    if (primary.missing) return null

    const backup = await readState(this.backupPathFor(appId))
    if (backup.state) return backup.state
    if (backup.unsupportedVersion !== undefined) {
      throw new MenuStateStoreError(
        'state-version-unsupported',
        `应用 ID ${appId} 的菜单状态备份版本 ${backup.unsupportedVersion} 高于当前支持版本 ${MENU_STATE_SCHEMA_VERSION}，拒绝静默覆盖。`,
      )
    }

    throw new MenuStateStoreError(
      'state-unreadable',
      `应用 ID ${appId} 的菜单状态文件无法读取，且没有可用的 .bak 备份。`,
      { cause: primary.error ?? backup.error },
    )
  }

  /** 原子写入状态，并把上一版保留为 `.bak`。 */
  async write(appId: string, state: MenuState): Promise<void> {
    const path = this.pathFor(appId)
    const backup = this.backupPathFor(appId)
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.mkdir(dirname(path), { recursive: true })
    try {
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      try {
        await fs.copyFile(path, backup)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      await this.replace(tmp, path)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw new MenuStateStoreError(
        'state-write-failed',
        `应用 ID ${appId} 的菜单状态写入失败。`,
        { cause: error },
      )
    }
  }

  private async replace(tmp: string, path: string) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, path)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        // Windows 上目标文件可能被短暂的读取占用，重试几次即可完成替换。
        if (attempt >= this.renameRetries || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
      }
    }
  }
}
