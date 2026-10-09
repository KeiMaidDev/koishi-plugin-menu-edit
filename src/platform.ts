/**
 * MenuPlatform：把 QQ 适配器的 `bot.internal.getMenu()` / `setMenu()` 收敛成
 * 菜单编辑服务可 fake 的平台边界。
 *
 * 服务层只依赖本接口，测试用 fake 实现模拟平台读写、离线与错误码；真实实现从
 * `ctx.bots` 里按 AppID 找到 `platform === 'qq'` 的机器人再调用 `internal`。
 */
import type { Context } from 'koishi'
import { appIdOf } from './bot-registry'
import { normalizePrivateMenu } from './configuration'
import { isRecord } from './guards'
import type { PrivateMenuConfiguration } from './types'

export type MenuPlatformErrorCode = 'bot-missing' | 'bot-offline' | 'platform-error'

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

export interface MenuPlatform {
  /** 读取当前 Private Menu；读取失败必须抛错，不能返回空配置。 */
  getPrivateMenu(appId: string): Promise<PlatformPrivateMenu>
  /** 整体覆盖写入 Private Menu，返回平台版本号。 */
  setPrivateMenu(appId: string, menu: PrivateMenuConfiguration): Promise<{ version: number | null }>
}

interface QQInternalLike {
  getMenu?: () => Promise<unknown>
  setMenu?: (data: { menu: PrivateMenuConfiguration }) => Promise<unknown>
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

/** 从 ctx.bots 里按 AppID 找到唯一的 QQ Bot Instance。 */
export function createKoishiMenuPlatform(ctx: Context): MenuPlatform {
  const bots = () => ctx.bots as unknown as QQBotLike[]

  const requireBot = (appId: string): QQBotLike => {
    const bot = bots().find(item => item.platform === 'qq' && appIdOf(item) === appId)
    if (!bot) throw new MenuPlatformError('bot-missing', `未找到 AppID 为 ${appId} 的 QQ Bot Instance。`)
    if (bot.isActive === false) throw new MenuPlatformError('bot-offline', `AppID ${appId} 的机器人当前不在线。`)
    return bot
  }

  return {
    async getPrivateMenu(appId) {
      const internal = requireBot(appId).internal
      if (!internal?.getMenu) {
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
      const internal = requireBot(appId).internal
      if (!internal?.setMenu) {
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
  }
}
