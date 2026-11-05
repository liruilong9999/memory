/**
 * 修正历史的**两个入口**：`memoryctl history` 与 `/memory history`。
 *
 * ## 为什么这两个入口要写在同一个文件里
 *
 * 仓库里「人读渲染有两份实现」这件事**曾经真的发生过**（见 `tests/core/render.test.ts`
 * 文件头：`/memory explain` 与 `query` 各写一遍，靠人肉同步）。历史渲染如果也照抄
 * 那个形态，就等着同一类漂移再来一次。
 *
 * 所以这里的核心断言不是「CLI 输出了什么」，而是**两边输出逐字相同**。
 * 只测一边的话，另一边的实现写错也全绿——它守不住「只有一份真相源」这个承诺。
 *
 * ## 为什么这个文件在 tests/cli/ 而不是 tests/host/
 *
 * 本轮并行任务（记忆压缩）正在改 `tests/host/`，为避免写范围冲突，
 * 宿主命令的用例放在这里，以「两个入口一致」的角度组织。
 *
 * @module tests/cli/history.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { EXIT_OK, EXIT_USAGE, EXIT_UNHEALTHY, helpText, runCli } from '../../src/cli/memoryctl.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import { formatCardRef } from '../../src/core/scoring.ts'
import { runMemoryCommand } from '../../src/host/plugin/commands.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import type { MemoryStore } from '../../src/store/store.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000

const tempDirs: string[] = []

/**
 * 建一个登记过的临时目录，`after` 里统一清理。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
function tempDir(prefix = 'dsh-memory-history-'): string {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

const fixedClock = (): number => T0

/**
 * 打开一个库并返回引擎与 store，供会话内命令直接调用。
 *
 * @param dir - 数据目录。
 * @returns 引擎与 store（调用方负责关闭 store）。
 */
function openEngine(dir: string): { engine: MemoryEngine; store: MemoryStore } {
  const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
  const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: fixedClock })
  return { engine, store }
}

/**
 * 种一张有两条修正历史的卡（走真实 `engine.revise`，不手工拼 `revisions`）。
 *
 * 为什么必须走真实写入：这个文件要证明的是「历史**存下来了、且两个入口都读得到**」。
 * 手工往数组里塞记录会把「写入路径坏了」这一半完全遮住。
 *
 * @param dir - 数据目录。
 * @returns 完整 id。
 */
function seedRevisedCard(dir: string): string {
  const { engine, store } = openEngine(dir)
  const card = {
    ...makeBaseCard(),
  }
  store.putCard(card)
  assert.equal(engine.revise(card.id, '生产环境部署必须先跑迁移脚本', '流程调整'), true, '前提：第一条修正必须写入')
  assert.equal(engine.revise(card.id, '生产环境部署必须先跑数据库迁移脚本', ''), true, '前提：第二条修正必须写入')
  assert.equal(engine.inspect(card.id)?.revisions.length, 2, '前提：两条记录都在')
  store.close()
  return card.id
}

/**
 * 造一张字段齐全的记忆卡（id 固定，方便在断言里引用）。
 *
 * @returns 记忆卡。
 */
function makeBaseCard(): {
  id: string
  domain: 'work'
  kind: 'fact'
  text: string
  normalized: string
  createdAt: number
  updatedAt: number
  source: { sessionId: string; turn: number; step: number; seq: number; eventType: string }
  salience: number
  confidence: number
  emotional: number
  strength: number
  accessCount: number
  lastAccessAt: null
  tags: string[]
  entities: string[]
  revisions: []
  status: 'active'
  conflictOf: string[]
  pinned: boolean
} {
  return {
    id: '3f9a1c02d4e5f607',
    domain: 'work',
    kind: 'fact',
    text: '生产环境部署必须先跑数据库迁移',
    normalized: '生产环境部署必须先跑数据库迁移',
    createdAt: T0,
    updatedAt: T0,
    source: { sessionId: 'sess-history', turn: 1, step: 1, seq: 1, eventType: 'user/message' },
    salience: 0.6,
    confidence: 0.8,
    emotional: 0.2,
    strength: 0.7,
    accessCount: 0,
    lastAccessAt: null,
    tags: [],
    entities: [],
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: false,
  }
}

describe('历史出口：CLI 与 /memory 两个入口必须一致', () => {
  it('/memory history 与 memoryctl history 对同一张卡输出逐字相同', () => {
    // 这条是本文件的核心：不是「各测各的」，而是**比对两个入口**。
    // 只测一边时，另一边的渲染漂移（漏掉原因、漏掉时间、换个措辞）不会红，
    // 而这正是本仓库历史上发生过的那类缺陷。
    const dir = tempDir()
    const id = seedRevisedCard(dir)

    const cli = runCli(['history', id, '--data-dir', dir, '--tz', TZ], { now: fixedClock })
    assert.equal(cli.code, EXIT_OK, cli.stderr)

    const { engine, store } = openEngine(dir)
    const session = runMemoryCommand(engine, `history ${id}`)
    store.close()

    assert.equal(session, cli.stdout.trimEnd(), '两个入口必须逐字一致（同一份渲染实现）')
    // 前提断言：两边都真的渲染出了内容，而不是「都空 → 都相等」。
    assert.match(session, /修正过 2 次/u)
    assert.ok(session.includes('原因：流程调整'), session)
    assert.ok(session.includes('原因：未填写原因'), session)
  })

  it('/memory history 支持前缀（用户抄的是输出里印的前缀）', () => {
    const dir = tempDir()
    const id = seedRevisedCard(dir)
    const prefix = formatCardRef(id)
    assert.equal(prefix, '3f9a1c02', '前提：16 位 id 的前 8 位就是要印出来的引用')

    const { engine, store } = openEngine(dir)
    const out = runMemoryCommand(engine, `history ${prefix}`)
    store.close()
    assert.ok(out.includes(`卡片 id ${id}`), out)
    assert.match(out, /修正过 2 次/u)
  })

  it('/memory history 缺 id 时给用法提示', () => {
    const dir = tempDir()
    seedRevisedCard(dir)
    const { engine, store } = openEngine(dir)
    const out = runMemoryCommand(engine, 'history')
    store.close()
    assert.match(out, /用法：\/memory history <卡片 id>/u)
  })

  it('/memory history 卡片不存在时说明情况，不返回空串', () => {
    const dir = tempDir()
    seedRevisedCard(dir)
    const { engine, store } = openEngine(dir)
    const out = runMemoryCommand(engine, 'history ffffffffffffffff')
    store.close()
    assert.match(out, /没有这张卡：ffffffffffffffff/u)
    assert.notEqual(out.trim().length, 0)
  })

  it('/memory history 前缀歧义时报错并列出候选，不挑一张', () => {
    const dir = tempDir()
    const { store } = openEngine(dir)
    store.putCard({ ...makeBaseCard(), id: 'abcd000000000000', text: '第一张同前缀卡' })
    store.putCard({ ...makeBaseCard(), id: 'abcd000000000001', text: '第二张同前缀卡' })
    store.close()

    const { engine, store: reopened } = openEngine(dir)
    const out = runMemoryCommand(engine, 'history abcd')
    reopened.close()
    assert.match(out, /匹配到 2 张，请给更长前缀：abcd/u)
    assert.ok(out.includes('abcd000000000000'), out)
    assert.ok(out.includes('abcd000000000001'), out)
    assert.doesNotMatch(out, /当前正文/u, '有歧义就不能输出任何一张卡的正文——那等于挑了一张')
  })
})

describe('renderFocusPackExplain 印出的 id 能直接粘给命令（闭环）', () => {
  it('/memory explain 输出的卡片 id 可以原样粘给 /memory revise', () => {
    // 这条守的是「卡片 id 可见」这个缺口的另一半：
    // 光印出来不够，必须**能拿回来用**。所以走一遍完整的
    // 「explain 印 id → 抄下那个字符串 → revise 用它」。
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    const card = makeBaseCard()
    store.putCard(card)
    const explained = runMemoryCommand(engine, 'explain 生产环境部署')
    const printed = explained
      .split('\n')
      .filter((line) => line.startsWith('  卡片 id '))
      .map((line) => line.slice('  卡片 id '.length))
    assert.equal(printed.length, 1, `前提：焦点包里应正好一张卡，实际输出：\n${explained}`)
    const ref = printed[0] ?? ''
    assert.equal(ref, formatCardRef(card.id), '印出来的必须是 formatCardRef 的结果')

    const revised = runMemoryCommand(engine, `revise ${ref} 部署前必须先跑迁移脚本`)
    assert.match(revised, /已修正/u, revised)
    assert.equal(engine.inspect(card.id)?.text, '部署前必须先跑迁移脚本', '改的必须是印出那张卡')
    store.close()
  })

  it('未知子命令的可用列表里含 history', () => {
    const dir = tempDir()
    seedRevisedCard(dir)
    const { engine, store } = openEngine(dir)
    const out = runMemoryCommand(engine, '乱写')
    store.close()
    assert.match(out, /未知子命令「乱写」/u)
    assert.match(out, /history/u, '新增了子命令就必须把它列进可用列表，否则等于藏起来')
  })
})

describe('history 子命令的用法与退出码约定', () => {
  it('--help 的用法表里列出了 history', () => {
    assert.match(helpText(), /history <id>/u)
  })

  it('未知子命令提示里含 history', () => {
    const result = runCli(['乱写'])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /history/u)
  })

  it('卡片不存在时退出 1，缺 id 时退出 2（两种失败不混用退出码）', () => {
    const missing = runCli(['history', 'ffffffffffffffff', '--data-dir', tempDir()])
    assert.equal(missing.code, EXIT_UNHEALTHY)
    const noId = runCli(['history', '--data-dir', tempDir()])
    assert.equal(noId.code, EXIT_USAGE)
    assert.notEqual(missing.code, noId.code, '「库里的东西不对」与「命令敲错了」必须能区分')
  })
})
