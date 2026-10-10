import { onlineStatus } from '../src/bot-status'
import type { BotInstanceSummary } from '../src/types'

/** status 插件 client store 中单个 Bot 的最小字段。 */
export interface BotStatusData {
  status?: number
}

/** status 插件 client store 的 `status` 快照。 */
export interface BotStatusSnapshot {
  bots?: Record<string, BotStatusData>
}

/**
 * 优先使用 status 插件的实时快照判定在线；快照尚未到达时回退到服务端结果。
 *
 * CONNECT / RECONNECT 在 Koishi 中仍是 isActive，但不是 ONLINE，面板必须显示离线。
 * status 快照已到达但缺少该 Bot 时同样视为离线，避免实例被移除后继续使用旧结果。
 */
export function resolveBotOnline(bot: BotInstanceSummary, snapshot?: BotStatusSnapshot): boolean {
  if (!snapshot) return bot.online
  return onlineStatus(snapshot.bots?.[bot.sid]?.status) ?? false
}