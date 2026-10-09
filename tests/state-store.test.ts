import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { MenuStateStore, MenuStateStoreError } from '../src/state-store'
import { makeState } from './harness'

const roots: string[] = []

function createStore(): MenuStateStore {
  const dataDir = mkdtempSync(join(tmpdir(), 'menu-edit-store-'))
  roots.push(dataDir)
  return new MenuStateStore({ dataDir })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('MenuStateStore：原子替换与备份', () => {
  it('连续写入后主文件是最新状态，.bak 是上一版', async () => {
    const store = createStore()
    const first = makeState('100', { revision: 1 })
    const second = makeState('100', { revision: 2 })

    await store.write('100', first)
    await store.write('100', second)

    assert.deepEqual(await store.read('100'), second)
    const backupRaw = await readFile(store.backupPathFor('100'), 'utf8')
    assert.deepEqual(JSON.parse(backupRaw), first)
  })

  it('主文件损坏时回退读取 .bak', async () => {
    const store = createStore()
    const first = makeState('100', { revision: 1 })
    const second = makeState('100', { revision: 2 })
    await store.write('100', first)
    await store.write('100', second)

    writeFileSync(store.pathFor('100'), '{ not valid json', 'utf8')

    assert.deepEqual(await store.read('100'), first)
  })

  it('主文件与备份都不可读时抛出 state-unreadable，不静默返回空状态', async () => {
    const store = createStore()
    await store.write('100', makeState('100', { revision: 1 }))
    writeFileSync(store.pathFor('100'), '{ not valid json', 'utf8')

    await assert.rejects(
      () => store.read('100'),
      (error: unknown) => error instanceof MenuStateStoreError && error.reason === 'state-unreadable',
    )
  })

  it('结构缺失的状态文件视为损坏，不静默使用', async () => {
    const store = createStore()
    await store.write('100', makeState('100', { revision: 1 }))
    const raw = JSON.parse(await readFile(store.pathFor('100'), 'utf8')) as Record<string, unknown>
    delete raw.published
    writeFileSync(store.pathFor('100'), JSON.stringify(raw), 'utf8')

    await assert.rejects(
      () => store.read('100'),
      (error: unknown) => error instanceof MenuStateStoreError && error.reason === 'state-unreadable',
    )
  })

  it('按 AppID 的文件互不影响', async () => {
    const store = createStore()
    await store.write('100', makeState('100', { revision: 1 }))
    await store.write('200', makeState('200', { revision: 9 }))

    assert.equal((await store.read('100'))?.revision, 1)
    assert.equal((await store.read('200'))?.revision, 9)
    assert.equal(await store.read('300'), null)
  })
})

