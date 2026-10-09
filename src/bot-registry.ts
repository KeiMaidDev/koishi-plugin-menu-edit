/**
 * Bot Registry：把 Koishi 的 `ctx.bots` 收敛成菜单编辑所需的 QQ Bot Instance 列表。
 *
 * 只有 `bot.platform === 'qq'` 的实例才是独立的菜单目标；`qqguild` 等子机器人不单独计数。
 * Bot Instance 的稳定键是 `bot.config.id`（QQ AppID），这也是状态隔离键。
 */
import type { Context } from 'koishi'
import type { BotInstanceSummary } from './types'

export interface BotRegistry {
  /** 返回全部可管理（platform === 'qq'）的 Bot Instance，按 AppID 去重。 */
  list(): BotInstanceSummary[]
  /** 该 AppID 是否是当前可管理的 QQ Bot Instance。 */
  has(appId: string): boolean
}

interface BotLike {
  platform?: string
  selfId?: string
  isActive?: boolean
  config?: { id?: unknown }
  user?: {
    name?: string
    nick?: string
    avatar?: string
  } | null
}

/** 兼容 bot.config.id 缺省或不是字符串的情况，统一转成隔离键。 */
export function appIdOf(bot: BotLike): string {
  const id = bot.config?.id
  if (typeof id === 'string' && id) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return String(bot.selfId ?? '')
}

export function summarizeBot(bot: BotLike): BotInstanceSummary | null {
  if (bot.platform !== 'qq') return null
  const appId = appIdOf(bot)
  if (!appId) return null
  return {
    appId,
    name: bot.user?.name || bot.user?.nick || appId,
    avatar: bot.user?.avatar ?? '',
    online: bot.isActive !== false,
  }
}

function collect(bots: BotLike[]): Map<string, BotInstanceSummary> {
  const summaries = new Map<string, BotInstanceSummary>()
  for (const bot of bots) {
    const summary = summarizeBot(bot)
    if (summary && !summaries.has(summary.appId)) summaries.set(summary.appId, summary)
  }
  return summaries
}

/** 用真实的 Koishi 上下文构造 BotRegistry；每次调用都重新读取 ctx.bots。 */
export function createKoishiBotRegistry(ctx: Context): BotRegistry {
  return {
    list: () => [...collect(ctx.bots as unknown as BotLike[]).values()],
    has: (appId) => collect(ctx.bots as unknown as BotLike[]).has(appId),
  }
}
