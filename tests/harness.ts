import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'koishi'
import { createKoishiBotRegistry } from '../src/bot-registry'
import { MenuService } from '../src/menu-service'
import type { MenuPlatform, PlatformPrivateMenu } from '../src/platform'
import { MenuStateStore } from '../src/state-store'
import {
  deepClone,
  emptyPanelConfiguration,
  MENU_STATE_SCHEMA_VERSION,
  type MenuState,
  type PrivateMenuConfiguration,
} from '../src/types'

export interface FakeBot {
  platform?: string
  selfId?: string
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
    published: { privateMenu: null, groupPanel: null },
    ...overrides,
  }
}

/** 可配置的 fake 平台：读/写/错误都受测试控制，不连接真实 QQ。 */
export class FakePlatform implements MenuPlatform {
  readonly menus = new Map<string, PlatformPrivateMenu>()
  readonly setCalls: { appId: string; menu: PrivateMenuConfiguration }[] = []
  getError: unknown = null
  setError: unknown = null
  private nextVersion = 1

  /** 直接写入平台侧菜单，模拟外部已有内容或外部写入者。 */
  seed(appId: string, menu: PrivateMenuConfiguration, version: number | null = null): void {
    this.menus.set(appId, { menu: deepClone(menu), version })
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
}

export interface Harness {
  service: MenuService
  store: MenuStateStore
  platform: FakePlatform
  dataDir: string
  /** 用同一个数据目录与平台重建 MenuService，模拟 Koishi 重启。 */
  restart(): MenuService
  cleanup(): void
}

/** 每个测试独立临时数据目录 + 真实 JSON store + fake BotRegistry + fake 平台。 */
export function createHarness(bots: FakeBot[] = DEFAULT_BOTS, now?: () => Date): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'menu-edit-'))
  const store = new MenuStateStore({ dataDir })
  const platform = new FakePlatform()
  const createService = () => {
    const registry = createKoishiBotRegistry({ bots } as unknown as Context)
    return new MenuService({ registry, store, platform, now })
  }
  const service = createService()
  return {
    service,
    store,
    platform,
    dataDir,
    restart: createService,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}
