/**
 * 客户端类型环境：@koishijs/client 的包入口是未编译的 TS 源码，直接纳入 tsc 会连带
 * 报出库内部错误。tsconfig.client.json 用 paths 把 `@koishijs/client` 的类型解析重定向
 * 到本文件，把库声明为不透明边界，只保留本插件面板用到的 API 签名。
 */
import type {} from 'vue'

export interface ElMessageApi {
  (options: { message: string; type?: 'success' | 'warning' | 'info' | 'error' }): void
  success(messageText: string): void
  warning(messageText: string): void
  info(messageText: string): void
  error(messageText: string): void
}

export const message: ElMessageApi

export interface ElMessageBoxApi {
  confirm(
    messageText: string,
    title?: string,
    options?: {
      type?: 'warning' | 'info' | 'success' | 'error'
      confirmButtonText?: string
      cancelButtonText?: string
    },
  ): Promise<void>
}

export const messageBox: ElMessageBoxApi

/** 控制台 WebSocket RPC；事件契约在 client/api.ts 里显式给出。 */
export function send<T = unknown>(event: string, ...args: unknown[]): Promise<T>

/** 控制台共享 store：面板只读 user 判断登录态。 */
export const store: { user?: Record<string, unknown> }

export interface ConsolePageOptions {
  path: string
  name: string
  order?: number
  authority?: number
  component: unknown
}

export interface Context {
  page(options: ConsolePageOptions): void
}
