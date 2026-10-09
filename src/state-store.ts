/**
 * 基于数据目录 JSON 文件的状态存储（ADR-0006）。
 *
 * 每个 Bot Instance 一个文件：`<dataDir>/menu-edit/<encoded-appId>.json`。
 * 写入按 AppID 串行化，先写临时文件再原子替换主文件，并保留上一版为 `.bak`；
 * 主文件损坏时回退读取 `.bak`，两者都不可读则报错而不是静默覆盖。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { isRecord } from './guards'
import { MENU_STATE_SCHEMA_VERSION, type MenuState } from './types'

export type MenuStateStoreErrorReason = 'state-unreadable' | 'state-write-failed'

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

function parseState(raw: string): MenuState | null {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) return null
  if (parsed.schemaVersion !== MENU_STATE_SCHEMA_VERSION) return null
  if (typeof parsed.appId !== 'string') return null
  if (typeof parsed.revision !== 'number' || !Number.isInteger(parsed.revision) || parsed.revision < 0) return null
  if (typeof parsed.updatedAt !== 'string') return null
  if (!isRecord(parsed.draft)) return null
  if (parsed.importedConfiguration !== null && !isRecord(parsed.importedConfiguration)) return null
  if (!isRecord(parsed.published)) return null
  return parsed as unknown as MenuState
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function readState(path: string): Promise<{ state: MenuState | null; missing: boolean; error?: unknown }> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    return { state: null, missing: isMissing(error), error }
  }
  try {
    const state = parseState(raw)
    return state ? { state, missing: false } : { state: null, missing: false, error: new Error('状态文件结构非法') }
  } catch (error) {
    return { state: null, missing: false, error }
  }
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
    if (primary.missing) return null

    const backup = await readState(this.backupPathFor(appId))
    if (backup.state) return backup.state

    throw new MenuStateStoreError(
      'state-unreadable',
      `AppID ${appId} 的菜单状态文件无法读取，且没有可用的 .bak 备份。`,
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
        `AppID ${appId} 的菜单状态写入失败。`,
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
