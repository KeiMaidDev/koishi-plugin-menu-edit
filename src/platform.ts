/**
 * MenuPlatform：把 QQ 适配器的菜单/面板 API 收敛成菜单编辑服务可 fake 的平台边界。
 *
 * 服务层只依赖本接口，测试用 fake 实现模拟平台读写、离线与错误码；真实实现从
 * `ctx.bots` 里按 AppID 找到 `platform === 'qq'` 的机器人再调用 `internal`。
 * Private Menu 走 getMenu/setMenu，Group Panel 走 getPanels/createPanel/modifyPanel/deletePanel。
 */
import type { Context } from 'koishi'
import { appIdOf } from './bot-registry'
import { normalizeGroupPanel, normalizePrivateMenu } from './configuration'
import { isRecord } from './guards'
import type { GroupPanelConfiguration, PrivateMenuConfiguration } from './types'

export type MenuPlatformErrorCode = 'bot-missing' | 'bot-offline' | 'platform-error' | 'quantity-limit' | 'panel-missing'

/** 平台交互失败；code 是稳定服务结果，原始异常只放在 cause 里。 */
export class MenuPlatformError extends Error {
  constructor(
    public readonly code: MenuPlatformErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'MenuPlatformError'
  }
}

export interface PlatformPrivateMenu {
  menu: PrivateMenuConfiguration
  version: number | null
}

/** 平台侧的单个 group 面板，含接管/清理所需的元数据与内容。 */
export interface PlatformGroupPanel {
  panelId: string
  targetType: string
  remark: string
  updatedAt: string | null
  version: number | null
  panel: GroupPanelConfiguration
}

export interface MenuPlatform {
  /** 读取当前 Private Menu；读取失败必须抛错，不能返回空配置。 */
  getPrivateMenu(appId: string): Promise<PlatformPrivateMenu>
  /** 整体覆盖写入 Private Menu，返回平台版本号。 */
  setPrivateMenu(appId: string, menu: PrivateMenuConfiguration): Promise<{ version: number | null }>

  /** 读取全部 group scope 的面板（分页拉完）；读取失败必须抛错。 */
  listGroupPanels(appId: string): Promise<PlatformGroupPanel[]>
  /** 创建 group/all 面板，返回新 panel ID。 */
  createGroupPanel(appId: string, panel: GroupPanelConfiguration): Promise<{ panelId: string; version: number | null }>
  /** 修改指定 Group Panel；面板不存在时抛 panel-missing。 */
  modifyGroupPanel(appId: string, panelId: string, panel: GroupPanelConfiguration): Promise<{ version: number | null }>
  /** 删除指定 Group Panel；40030006 视为已不存在（幂等），不抛错。 */
  deleteGroupPanel(appId: string, panelId: string): Promise<void>
}

interface QQInternalLike {
  getMenu?: () => Promise<unknown>
  setMenu?: (data: { menu: PrivateMenuConfiguration }) => Promise<unknown>
  getPanels?: (params: Partial<{ scope: string; cursor: string; limit: number }>) => Promise<unknown>
  createPanel?: (data: unknown) => Promise<unknown>
  modifyPanel?: (panelId: string, data: unknown) => Promise<unknown>
  deletePanel?: (panelId: string) => Promise<unknown>
}

interface QQBotLike {
  platform?: string
  selfId?: string
  isActive?: boolean
  config?: { id?: unknown }
  internal?: QQInternalLike
}

function readVersion(value: unknown): number | null {
  if (!isRecord(value)) return null
  const version = value.version
  return typeof version === 'number' && Number.isFinite(version) ? version : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 与 adapter-qq-crack 相同的错误码提取口径，兼容 axios error 的多种字段。 */
function platformErrorCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  const response = isRecord(error.response) ? error.response : undefined
  const data = response && isRecord(response.data) ? response.data : undefined
  const candidates = [data?.err_code, error.err, data?.code, error.code, data?.err]
  for (const candidate of candidates) {
    if (typeof candidate === 'number') return candidate
  }
  return undefined
}

function groupPanelOf(record: Record<string, unknown>): GroupPanelConfiguration {
  return normalizeGroupPanel(record.panel)
}

function toPlatformGroupPanel(record: Record<string, unknown>): PlatformGroupPanel | null {
  const panelId = readString(record.panel_id)
  if (!panelId) return null
  return {
    panelId,
    targetType: readString(record.target_type),
    remark: readString(isRecord(record.panel) ? record.panel.remark : ''),
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
    version: readVersion(record.panel ?? record),
    panel: groupPanelOf(record),
  }
}

/** 从 ctx.bots 里按 AppID 找到唯一的 QQ Bot Instance。 */
export function createKoishiMenuPlatform(ctx: Context): MenuPlatform {
  const bots = () => ctx.bots as unknown as QQBotLike[]

  const requireBot = (appId: string): QQBotLike => {
    const bot = bots().find(item => item.platform === 'qq' && appIdOf(item) === appId)
    if (!bot) throw new MenuPlatformError('bot-missing', `未找到 AppID 为 ${appId} 的 QQ Bot Instance。`)
    if (bot.isActive === false) throw new MenuPlatformError('bot-offline', `AppID ${appId} 的机器人当前不在线。`)
    return bot
  }

  const requireInternal = (appId: string): QQInternalLike => {
    const internal = requireBot(appId).internal
    if (!internal) throw new MenuPlatformError('platform-error', `AppID ${appId} 的 QQ 适配器未提供 internal API。`)
    return internal
  }

  return {
    async getPrivateMenu(appId) {
      const internal = requireInternal(appId)
      if (!internal.getMenu) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 QQ 适配器未提供 getMenu()。`)
      }
      let response: unknown
      try {
        response = await internal.getMenu()
      } catch (error) {
        throw new MenuPlatformError('platform-error', `读取 AppID ${appId} 的 Private Menu 失败。`, { cause: error })
      }
      if (!isRecord(response)) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 getMenu() 返回结构非法。`)
      }
      return { menu: normalizePrivateMenu(response.menu), version: readVersion(response) }
    },

    async setPrivateMenu(appId, menu) {
      const internal = requireInternal(appId)
      if (!internal.setMenu) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 QQ 适配器未提供 setMenu()。`)
      }
      let response: unknown
      try {
        response = await internal.setMenu({ menu })
      } catch (error) {
        throw new MenuPlatformError('platform-error', `写入 AppID ${appId} 的 Private Menu 失败。`, { cause: error })
      }
      return { version: readVersion(response) }
    },

    async listGroupPanels(appId) {
      const internal = requireInternal(appId)
      if (!internal.getPanels) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 QQ 适配器未提供 getPanels()。`)
      }
      const panels: PlatformGroupPanel[] = []
      const seen = new Set<string>()
      let cursor = ''
      for (;;) {
        let page: unknown
        try {
          page = await internal.getPanels({ scope: 'group', cursor, limit: 50 })
        } catch (error) {
          throw new MenuPlatformError('platform-error', `读取 AppID ${appId} 的 Group Panel 失败。`, { cause: error })
        }
        if (!isRecord(page)) {
          throw new MenuPlatformError('platform-error', `AppID ${appId} 的 getPanels() 返回结构非法。`)
        }
        const records = Array.isArray(page.records) ? page.records : []
        for (const record of records) {
          if (!isRecord(record)) continue
          const mapped = toPlatformGroupPanel(record)
          if (mapped) panels.push(mapped)
        }
        const next = readString(page.next_cursor)
        if (page.is_end === true || !next || seen.has(next)) break
        seen.add(next)
        cursor = next
      }
      return panels
    },

    async createGroupPanel(appId, panel) {
      const internal = requireInternal(appId)
      if (!internal.createPanel) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 QQ 适配器未提供 createPanel()。`)
      }
      let response: unknown
      try {
        response = await internal.createPanel({ scope: 'group', target_type: 'all', panel })
      } catch (error) {
        throw mapPanelError(error, `创建 AppID ${appId} 的 Group Panel 失败。`)
      }
      const panelId = isRecord(response) ? readString(response.panel_id) : ''
      if (!panelId) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 createPanel() 未返回 panel_id。`)
      }
      return { panelId, version: readVersion(response) }
    },

    async modifyGroupPanel(appId, panelId, panel) {
      const internal = requireInternal(appId)
      if (!internal.modifyPanel) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 QQ 适配器未提供 modifyPanel()。`)
      }
      let response: unknown
      try {
        response = await internal.modifyPanel(panelId, { panel })
      } catch (error) {
        throw mapPanelError(error, `修改 AppID ${appId} 的 Group Panel ${panelId} 失败。`)
      }
      return { version: readVersion(response) }
    },

    async deleteGroupPanel(appId, panelId) {
      const internal = requireInternal(appId)
      if (!internal.deletePanel) {
        throw new MenuPlatformError('platform-error', `AppID ${appId} 的 QQ 适配器未提供 deletePanel()。`)
      }
      try {
        await internal.deletePanel(panelId)
      } catch (error) {
        // 40030006：面板已被平台删除或被其他写入者替换，删除目标是幂等的。
        if (platformErrorCode(error) === 40030006) return
        throw mapPanelError(error, `删除 AppID ${appId} 的 Group Panel ${panelId} 失败。`)
      }
    },
  }
}

function mapPanelError(error: unknown, message: string): MenuPlatformError {
  const code = platformErrorCode(error)
  if (code === 40030013) {
    return new MenuPlatformError('quantity-limit', 'QQ 平台返回条目数量超限（40030013）。', { cause: error })
  }
  if (code === 40030006) {
    return new MenuPlatformError('panel-missing', 'QQ 平台返回面板不存在（40030006）。', { cause: error })
  }
  return new MenuPlatformError('platform-error', message, { cause: error })
}
