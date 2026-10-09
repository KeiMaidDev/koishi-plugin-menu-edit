import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'koishi'
import { createKoishiBotRegistry } from '../src/bot-registry'
import { MenuService } from '../src/menu-service'
import { MenuStateStore } from '../src/state-store'
import { emptyPanelConfiguration, MENU_STATE_SCHEMA_VERSION, type MenuState } from '../src/types'

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

export interface Harness {
  service: MenuService
  store: MenuStateStore
  dataDir: string
  /** 用同一个数据目录重建 MenuService，模拟 Koishi 重启。 */
  restart(): MenuService
  cleanup(): void
}

/** 每个测试独立临时数据目录 + 真实 JSON store + fake BotRegistry。 */
export function createHarness(bots: FakeBot[] = DEFAULT_BOTS, now?: () => Date): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'menu-edit-'))
  const store = new MenuStateStore({ dataDir })
  const createService = () => {
    const registry = createKoishiBotRegistry({ bots } as unknown as Context)
    return new MenuService({ registry, store, now })
  }
  const service = createService()
  return {
    service,
    store,
    dataDir,
    restart: createService,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

