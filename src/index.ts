import { join } from 'node:path'
import { Context, Schema } from 'koishi'
import type {} from '@koishijs/console'
import { createKoishiBotRegistry } from './bot-registry'
import { setupConsole } from './console'
import { MenuService } from './menu-service'
import { createKoishiMenuPlatform } from './platform'
import { MenuStateStore } from './state-store'

export const name = 'menu-edit'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

/**
 * 插件入口：组装按 AppID 隔离的 JSON 状态存储、QQ 平台边界和 MenuService，
 * 并把 Console 页面按需挂上。
 *
 * 服务端子插件通过可选 inject 等待 console 就绪；没有 Console 时插件其余部分照常加载。
 */
export function apply(ctx: Context, _config: Config) {
  const store = new MenuStateStore({ dataDir: join(ctx.baseDir, 'data') })
  const service = new MenuService({
    registry: createKoishiBotRegistry(ctx),
    store,
    platform: createKoishiMenuPlatform(ctx),
  })
  ctx.plugin(setupConsole, { service })
}

export { MenuService, MenuServiceError } from './menu-service'
export { createKoishiMenuPlatform, MenuPlatformError } from './platform'
export { displayWidth, validateCommandPanel, validatePanelConfiguration, validatePrivateMenu } from './validation'
export { deriveScopePanel, deriveScopeItems, panelItemScopes, scopeItemCounts, stripPanelItemScopes } from './command-panel'
export { MenuStateStore, MenuStateStoreError } from './state-store'
export { CONSOLE_PANEL_AUTHORITY } from './console-permission'
export * from './types'
