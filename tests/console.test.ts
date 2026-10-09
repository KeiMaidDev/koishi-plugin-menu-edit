import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { resolveConsoleEntry, setupConsole } from '../src/console'
import { CONSOLE_PANEL_AUTHORITY } from '../src/console-permission'
import { createHarness } from './harness'

const pkgName: string = require('../package.json').name
const roots: string[] = []

function fakeRoot(...links: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'menu-edit-console-'))
  roots.push(root)
  for (const link of links) mkdirSync(join(root, link), { recursive: true })
  return root
}

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Menu Edit Console：权限与入口', () => {
  it('页面 RPC 的门槛是 authority 4', () => {
    const captured: { event: string; authority?: number }[] = []
    const entries: unknown[] = []
    const ctx = {
      baseDir: fakeRoot(),
      logger: () => ({ warn: () => {} }),
      console: {
        addListener: (event: string, _callback: unknown, options?: { authority?: number }) => {
          captured.push({ event, authority: options?.authority })
        },
        addEntry: (files: unknown) => entries.push(files),
      },
    }
    const { service, cleanup } = createHarness()
    try {
      setupConsole(ctx as never, { service })
    } finally {
      cleanup()
    }

    assert.equal(CONSOLE_PANEL_AUTHORITY, 4)
    assert.deepEqual(captured.map(item => item.event), [
      'menu-edit/bots',
      'menu-edit/workspace',
      'menu-edit/save-draft',
      'menu-edit/discard-draft',
    ])
    for (const item of captured) assert.equal(item.authority, 4, `${item.event} 必须要求 authority 4`)
    assert.equal(entries.length, 1, '必须注册客户端 entry')
  })

  it('生产模式 entry 走 node_modules 链接路径，避免 Console 静态服务 403', () => {
    const baseDir = fakeRoot(join('node_modules', pkgName, 'dist'))
    const { prod } = resolveConsoleEntry({ baseDir })

    assert.equal(prod, join(baseDir, 'node_modules', pkgName, 'dist'))
    assert.ok(existsSync(prod))
    assert.ok(prod.includes('node_modules'))
  })

  it('安装目录名与 package.json 的 name 不一致时回退到插件目录', () => {
    const baseDir = fakeRoot(join('node_modules', 'koishi-plugin-menu-edit-typo', 'dist'))
    const { prod } = resolveConsoleEntry({ baseDir })
    assert.ok(!prod.includes('node_modules'))
  })
})

