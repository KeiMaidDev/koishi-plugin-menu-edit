import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveBotOnline } from '../client/bot-status'
import type { BotInstanceSummary } from '../src/types'

const bot: BotInstanceSummary = {
  appId: '100',
  sid: 'qq:100',
  name: '一号机',
  avatar: '',
  online: true,
}

describe('client：Bot 在线状态', () => {
  it('优先读取 status 插件快照，并只把 ONLINE 视为在线', () => {
    assert.equal(resolveBotOnline(bot, { bots: { 'qq:100': { status: 1 } } }), true)
    assert.equal(resolveBotOnline(bot, { bots: { 'qq:100': { status: 2 } } }), false)
    assert.equal(resolveBotOnline(bot, { bots: { 'qq:100': { status: 4 } } }), false)
    assert.equal(resolveBotOnline(bot, { bots: { 'qq:100': { status: 0 } } }), false)
  })

  it('status 快照未到达时回退到服务端结果，快照到达后缺少 Bot 视为离线', () => {
    assert.equal(resolveBotOnline(bot), true)
    assert.equal(resolveBotOnline(bot, { bots: {} }), false)
    assert.equal(resolveBotOnline({ ...bot, online: false }, { bots: {} }), false)
  })
})
