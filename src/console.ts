/**
 * Menu Edit Panel 的服务端 Console 子插件。
 *
 * 只做鉴权、参数转换和错误包装，所有业务规则都在 MenuService 内；读取 RPC 同样要求
 * authority 4，不向低权限用户暴露机器人菜单内容。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from 'koishi'
import type {} from '@koishijs/console'
import type { MenuService } from './menu-service'
import { CONSOLE_PANEL_AUTHORITY } from './console-permission'
import type {
  BotInstanceSummary,
  DiscardDraftInput,
  DraftMutationResult,
  GroupPanelPublishInput,
  GroupPanelPublishResult,
  ImportGroupPanelInput,
  ImportGroupPanelResult,
  ImportPrivateMenuInput,
  ImportPrivateMenuResult,
  PrivateMenuPublishInput,
  PrivateMenuPublishResult,
  SaveDraftInput,
  WorkspaceSnapshot,
} from './types'

declare module '@koishijs/console' {
  interface Events {
    'menu-edit/bots'(): Promise<BotInstanceSummary[]>
    'menu-edit/workspace'(appId: string): Promise<WorkspaceSnapshot>
    'menu-edit/save-draft'(input: SaveDraftInput): Promise<DraftMutationResult>
    'menu-edit/discard-draft'(input: DiscardDraftInput): Promise<DraftMutationResult>
    'menu-edit/import-private-menu'(input: ImportPrivateMenuInput): Promise<ImportPrivateMenuResult>
    'menu-edit/publish-private-menu'(input: PrivateMenuPublishInput): Promise<PrivateMenuPublishResult>
    'menu-edit/import-group-panel'(input: ImportGroupPanelInput): Promise<ImportGroupPanelResult>
    'menu-edit/publish-group-panel'(input: GroupPanelPublishInput): Promise<GroupPanelPublishResult>
  }
}

/** Console RPC 命名空间。 */
export const CONSOLE_API_PREFIX = 'menu-edit'

/**
 * node_modules 下的安装目录名。生产模式下 Console 静态服务只放行路径含 node_modules
 * 的文件；本插件经 workspace junction 被 Node realpath 到 external/ 下，只有走这个
 * 链接路径才能通过。从 package.json 的 name 推导，避免包名改动后这里再漂移。
 */
const PKG_NAME: string = require('../package.json').name

/**
 * 计算 Console 客户端 entry 路径。
 * dev 路径必须相对插件根解析，否则 devMode 会静默回退 prod bundle；
 * prod 优先走 node_modules 链接路径，真实安装时回退插件目录下的 dist。
 */
export function resolveConsoleEntry(ctx: Pick<Context, 'baseDir'>): { dev: string; prod: string } {
  const pluginRoot = path.resolve(__dirname, '..')
  const viaNodeModules = path.resolve(ctx.baseDir, 'node_modules', PKG_NAME, 'dist')
  return {
    dev: path.resolve(pluginRoot, 'client/index.ts'),
    prod: fs.existsSync(viaNodeModules) ? viaNodeModules : path.resolve(pluginRoot, 'dist'),
  }
}

export interface ConsoleOptions {
  service: MenuService
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 注册 Console 页面入口与 RPC。
 * console 服务未就绪时 cordis 会在其可用后重新加载本子插件。
 */
export const setupConsole = Object.assign(
  function setupConsole(ctx: Context, options: ConsoleOptions) {
    if (!ctx.console) return

    const logger = ctx.logger('menu-edit')
    const service = options.service

    const run = async <T>(label: string, task: () => Promise<T> | T): Promise<T> => {
      try {
        return await task()
      } catch (error) {
        logger.warn('%s失败：%s', label, errorMessage(error))
        throw new Error(`${label}失败：${errorMessage(error)}`)
      }
    }

    const requireAuthority = { authority: CONSOLE_PANEL_AUTHORITY }

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/bots`, () =>
      run('加载机器人列表', () => service.listBots()), requireAuthority)

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/workspace`, (appId) =>
      run('加载工作区', () => service.loadWorkspace(String(appId ?? ''))), requireAuthority)

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/save-draft`, (input) =>
      run('保存 Draft', () => service.saveDraft(input as SaveDraftInput)), requireAuthority)

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/discard-draft`, (input) =>
      run('Discard Draft', () => service.discardDraft(input as DiscardDraftInput)), requireAuthority)

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/import-private-menu`, (input) =>
      run('导入 Private Menu', () => service.importPrivateMenu(input as ImportPrivateMenuInput)), requireAuthority)

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/publish-private-menu`, (input) =>
      run('Publish Private Menu', () => service.publishPrivateMenu(input as PrivateMenuPublishInput)), requireAuthority)

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/import-group-panel`, (input) =>
      run('导入 Group Panel', () => service.importGroupPanel(input as ImportGroupPanelInput)), requireAuthority)

    ctx.console.addListener(`${CONSOLE_API_PREFIX}/publish-group-panel`, (input) =>
      run('Publish Group Panel', () => service.publishGroupPanel(input as GroupPanelPublishInput)), requireAuthority)

    ctx.console.addEntry(resolveConsoleEntry(ctx))
  },
  { inject: { console: { required: false } } },
)
