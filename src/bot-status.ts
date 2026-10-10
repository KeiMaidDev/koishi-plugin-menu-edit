import { BOT_STATUS_ONLINE } from './types'

/** 把 status 插件暴露的原始状态值映射为在线布尔值；字段缺失时返回 undefined。 */
export function onlineStatus(status: unknown): boolean | undefined {
  if (typeof status !== 'number') return undefined
  return status === BOT_STATUS_ONLINE
}

/**
 * 判定没有 status 插件快照时的在线状态。
 *
 * CONNECT / RECONNECT 期间 Koishi 的 isActive 仍为 true，但它们不是 ONLINE，不能算在线。
 */
export function resolveOnlineStatus(status: unknown, isActive: unknown): boolean {
  return onlineStatus(status) ?? isActive !== false
}