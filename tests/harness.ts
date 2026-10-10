import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'koishi'
import { createKoishiBotRegistry } from '../src/bot-registry'
import { MenuService } from '../src/menu-service'
import { MenuPlatformError, type MenuPlatform, type PlatformCommandPanel, type PlatformPrivateMenu } from '../src/platform'
import { MenuStateStore } from '../src/state-store'
import {
  deepClone,
  emptyPanelConfiguration,
  MENU_STATE_SCHEMA_VERSION,
  type CommandPanelConfiguration,
  type MenuState,
  type PanelScope,
  type PrivateMenuConfiguration,
} from '../src/types'

export interface FakeBot {
  platform?: string
  sid?: string
  selfId?: string
  status?: number
  isActive?: boolean
  config?: { id?: unknown }
  user?: { name?: string; nick?: string; avatar?: string } | null
}

/** 默认两台 QQ 机器人，其中 200 离线；用 AppID 作为隔离键。 */
export const DEFAULT_BOTS: FakeBot[] = [
  {
    platform: 'qq',
    selfId: '100',
    config: { id: '100' },
    isActive: true,
    user: { name: '一号机', avatar: 'https://example.com/100.png' },
  },
  {
    platform: 'qq',
    selfId: '200',
    config: { id: '200' },
    isActive: false,
    user: { name: '二号机', avatar: '' },
  },
]

/** 构造一份合法状态文件，用于模拟首次导入或已发布后的重启状态。 */
export function makeState(appId: string, overrides: Partial<MenuState> = {}): MenuState {
  return {
    schemaVersion: MENU_STATE_SCHEMA_VERSION,
    appId,
    revision: 3,
    updatedAt: '2026-10-10T00:00:00.000Z',
    importedConfiguration: null,
    draft: emptyPanelConfiguration(),
    published: { privateMenu: null, commandPanels: {} },
    ...overrides,
  }
}

export interface FakeCommandPanelSeed {
  targetType?: string
  remark?: string
  updatedAt?: string | null
  version?: number | null
}

export interface RecordedPanelWrite {
  appId: string
  op: 'create' | 'modify' | 'delete'
  scope: PanelScope | null
  panelId: string
  at: number
}

/** 可配置的 fake 平台：读/写/错误都受测试控制，不连接真实 QQ。 */
export class FakePlatform implements MenuPlatform {
  readonly menus = new Map<string, PlatformPrivateMenu>()
  readonly setCalls: { appId: string; menu: PrivateMenuConfiguration }[] = []
  readonly panelWrites: RecordedPanelWrite[] = []
  getError: unknown = null
  setError: unknown = null
  listPanelError: unknown = null
  createPanelError: unknown = null
  createPanelErrors = new Map<PanelScope, unknown>()
  modifyPanelError: unknown = null
  deletePanelErrors = new Map<string, unknown>()
  private nextVersion = 1
  private nextPanelVersion = 1
  private nextPanelSequence = 1
  private readonly panels = new Map<string, Map<string, PlatformCommandPanel>>()

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private panelsOf(appId: string): Map<string, PlatformCommandPanel> {
    let panels = this.panels.get(appId)
    if (!panels) {
      panels = new Map()
      this.panels.set(appId, panels)
    }
    return panels
  }

  /** 直接写入平台侧菜单，模拟外部已有内容或外部写入者。 */
  seed(appId: string, menu: PrivateMenuConfiguration, version: number | null = null): void {
    this.menus.set(appId, { menu: deepClone(menu), version })
  }

  /** 直接写入平台侧指定场景的面板，模拟外部已有内容或外部写入者。 */
  seedCommandPanel(
    appId: string,
    panelId: string,
    scope: PanelScope,
    panel: CommandPanelConfiguration,
    options: FakeCommandPanelSeed = {},
  ): void {
    this.panelsOf(appId).set(panelId, {
      panelId,
      scope,
      targetType: options.targetType ?? 'all',
      remark: options.remark ?? (typeof panel.remark === 'string' ? panel.remark : ''),
      updatedAt: options.updatedAt ?? '2026-10-10T00:00:00.000Z',
      version: options.version ?? 1,
      panel: deepClone(panel),
    })
  }

  /** 列出平台侧面板；传 scope 时只返回该场景。 */
  listOf(appId: string, scope?: PanelScope): PlatformCommandPanel[] {
    const all = [...this.panelsOf(appId).values()].map(panel => deepClone(panel))
    return scope ? all.filter(panel => panel.scope === scope) : all
  }

  /** 模拟外部写入者直接删除某个面板。 */
  removeCommandPanel(appId: string, panelId: string): void {
    this.panelsOf(appId).delete(panelId)
  }

  async getPrivateMenu(appId: string): Promise<PlatformPrivateMenu> {
    if (this.getError) throw this.getError
    return deepClone(this.menus.get(appId) ?? { menu: { items: [] }, version: null })
  }

  async setPrivateMenu(appId: string, menu: PrivateMenuConfiguration): Promise<{ version: number | null }> {
    if (this.setError) throw this.setError
    this.setCalls.push({ appId, menu: deepClone(menu) })
    const version = this.nextVersion++
    this.menus.set(appId, { menu: deepClone(menu), version })
    return { version }
  }

  async listCommandPanels(appId: string, scope: PanelScope): Promise<PlatformCommandPanel[]> {
    if (this.listPanelError) throw this.listPanelError
    return this.listOf(appId, scope)
  }

  async createCommandPanel(
    appId: string,
    scope: PanelScope,
    panel: CommandPanelConfiguration,
  ): Promise<{ panelId: string; version: number | null }> {
    const createError = this.createPanelErrors.get(scope) ?? this.createPanelError
    if (createError) throw createError
    const panelId = `panel-${this.nextPanelSequence++}`
    const version = this.nextPanelVersion++
    this.panelsOf(appId).set(panelId, {
      panelId,
      scope,
      targetType: 'all',
      remark: typeof panel.remark === 'string' ? panel.remark : '',
      updatedAt: new Date(this.clock()).toISOString(),
      version,
      panel: deepClone(panel),
    })
    this.panelWrites.push({ appId, op: 'create', scope, panelId, at: this.clock() })
    return { panelId, version }
  }

  async modifyCommandPanel(
    appId: string,
    panelId: string,
    panel: CommandPanelConfiguration,
  ): Promise<{ version: number | null }> {
    if (this.modifyPanelError) throw this.modifyPanelError
    const existing = this.panelsOf(appId).get(panelId)
    if (!existing) throw new MenuPlatformError('panel-missing', `panel ${panelId} 不存在`)
    const version = this.nextPanelVersion++
    this.panelsOf(appId).set(panelId, {
      ...existing,
      remark: typeof panel.remark === 'string' ? panel.remark : existing.remark,
      updatedAt: new Date(this.clock()).toISOString(),
      version,
      panel: deepClone(panel),
    })
    this.panelWrites.push({ appId, op: 'modify', scope: existing.scope, panelId, at: this.clock() })
    return { version }
  }

  async deleteCommandPanel(appId: string, panelId: string): Promise<void> {
    const error = this.deletePanelErrors.get(panelId)
    if (error) throw error
    const existing = this.panelsOf(appId).get(panelId)
    this.panelsOf(appId).delete(panelId)
    this.panelWrites.push({ appId, op: 'delete', scope: existing?.scope ?? null, panelId, at: this.clock() })
  }
}

export interface HarnessOptions {
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export interface Harness {
  service: MenuService
  store: MenuStateStore
  platform: FakePlatform
  dataDir: string
  /** fake 时钟当前毫秒值；sleep 会推进它，用于断言 6500ms 节流。 */
  time: () => number
  /** 用同一个数据目录与平台重建 MenuService，模拟 Koishi 重启。 */
  restart(): MenuService
  cleanup(): void
}

/** 每个测试独立临时数据目录 + 真实 JSON store + fake BotRegistry + fake 平台 + fake clock。 */
export function createHarness(bots: FakeBot[] = DEFAULT_BOTS, options: HarnessOptions = {}): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'menu-edit-'))
  const store = new MenuStateStore({ dataDir })
  let currentTime = Date.parse('2026-10-10T00:00:00.000Z')
  const now = options.now ?? (() => new Date(currentTime))
  const sleep = options.sleep ?? (async (ms: number) => {
    currentTime += ms
  })
  const platform = new FakePlatform(() => now().getTime())
  const createService = () => {
    const registry = createKoishiBotRegistry({ bots } as unknown as Context)
    return new MenuService({ registry, store, platform, now, sleep })
  }
  const service = createService()
  return {
    service,
    store,
    platform,
    dataDir,
    time: () => now().getTime(),
    restart: createService,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}
