/**
 * FR-F1 诊断日志落盘的测试。
 *
 * 落盘之前 `onLog` 是唯一出口，而它只在 CLI 里被接成「攒数组、--verbose 打印」。
 * 宿主跑一整天，write / recall / consolidate 的记录**一条都没留下**，重启清零。
 * FR-F1 要的是「最近 N 次操作可回溯」——出问题时恰恰是「上一次运行发生了什么」
 * 查不到，而进程内的数组给不了这个答案。
 *
 * 所以本文件的核心断言是**跨进程**：写完关库，重开后还能读到。
 * 只断言「文件存在」没有意义——空文件也满足。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG, mergeConfig } from '../../src/core/config.ts'
import type { MemoryConfig } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import type { MemoryLogEntry } from '../../src/core/types.ts'
import { openStore } from '../../src/store/store.ts'
import { runCli } from '../../src/cli/memoryctl.ts'

const T0 = Date.UTC(2023, 10, 15, 6, 13, 0)
const TZ = 'Asia/Shanghai'

let root = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-logs-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个独立的数据目录。 */
function tempDir(): string {
  return mkdtempSync(join(root, 'case-'))
}

/** 打开引擎。 */
function openEngine(dataDir: string, config: MemoryConfig = DEFAULT_CONFIG): {
  store: ReturnType<typeof openStore>
  engine: MemoryEngine
} {
  const store = openStore({ dataDir, config })
  const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: () => T0 })
  return { store, engine }
}

/** 一轮会产生记忆卡写入的对话。 */
function writeOnce(engine: MemoryEngine, at = T0, seq = 1): void {
  engine.writeTurn({
    sessionId: 's1',
    turn: seq,
    step: 1,
    seq,
    userText: '这个项目用 Redis 做缓存，部署在 Kubernetes 上',
    assistantText: '好的，记下了',
    domain: 'work',
    at,
  })
}

/** 读回落盘的诊断日志。 */
function readLog(dataDir: string, config: MemoryConfig = DEFAULT_CONFIG): MemoryLogEntry[] {
  // 空串表示不落盘：join(dir, '') 会得到目录本身，直接 read 会 EISDIR。
  if (config.storage.logFile.length === 0) return []
  const path = join(dataDir, config.storage.logFile)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MemoryLogEntry)
}

describe('FR-F1 · 诊断日志必须落盘', () => {
  it('写入操作会落一条 write 日志到磁盘', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    writeOnce(engine)
    store.close()

    const entries = readLog(dir)
    assert.ok(entries.length > 0, '磁盘上必须有日志——只进内存等于没落盘')
    const writeEntry = entries.find((entry) => entry.kind === 'write')
    assert.ok(writeEntry !== undefined, '必须有一条 write 记录')
    assert.ok(writeEntry.summary.length > 0, '摘要必须可读')
  })

  it('跨进程：关库重开后仍能读到上次运行的日志', () => {
    // 这条是**真正的那条**：进程内数组也能通过上面那条，
    // 但只有落盘才能跨进程。
    const dir = tempDir()
    const first = openEngine(dir)
    writeOnce(first.engine)
    first.store.close()

    const countAfterFirst = readLog(dir).length
    assert.ok(countAfterFirst > 0, '前提：第一次运行必须写了日志')

    // 模拟「新进程」：只读磁盘，不碰上一个引擎。
    const entries = readLog(dir)
    assert.equal(entries.length, countAfterFirst, '重开后必须还能读到同样多的记录')
    assert.ok(
      entries.every((entry) => typeof entry.at === 'number'),
      '每条记录必须带时刻',
    )
  })

  it('日志不落进事件日志：journal 分片里没有日志记录', () => {
    // P2：journal 是唯一真相源，诊断日志是可丢弃旁路。
    // 混进去会让重放依赖观测记录，也让日志体积失控。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    writeOnce(engine)
    const journalPath = join(dir, 'journal-000001.jsonl')
    assert.ok(existsSync(journalPath), '前提：事件日志必须存在')
    const journalText = readFileSync(journalPath, 'utf8')
    assert.doesNotMatch(journalText, /"kind":"recall"/u, 'journal 里不能出现诊断日志的 kind 字段')
    store.close()
  })

  it('诊断日志与事件日志必须分目录：按 *.jsonl 扫顶层只能看到事件日志', () => {
    // 加上落盘后 tests/cli/memoryctl.test.ts 的 journalSize 立刻红了
    // （它按后缀扫顶层、断言恰好一个文件）。那条断言守的是真实不变量，
    // 该改的是实现不是测试——诊断日志若与分片同层，任何按 *.jsonl 扫描
    // dataDir 的外部工具都会把旁路记录当成事件日志。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    writeOnce(engine)
    store.close()

    // 用 fs 直接列，不用生产代码的 listShardFiles——那一个用前缀过滤，
    // 看不到「同层还有别的 jsonl」这个问题，也就守不住这条不变量。
    const jsonlAtTop = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    assert.deepEqual(
      jsonlAtTop,
      ['journal-000001.jsonl'],
      'dataDir 顶层只能有事件日志分片；诊断日志必须在子目录里',
    )
  })

  it('logFile 为空串时不落盘（用户显式关闭）', () => {
    const dir = tempDir()
    const config = mergeConfig(DEFAULT_CONFIG, { storage: { logFile: '' } })
    const { store, engine } = openEngine(dir, config)
    writeOnce(engine)
    store.close()

    assert.equal(readLog(dir, config).length, 0, '关掉之后不该产生文件')
  })

  it('logMaxEntries 生效：超出上限时保留最后 N 条', () => {
    const dir = tempDir()
    const config = mergeConfig(DEFAULT_CONFIG, { storage: { logMaxEntries: 3 } })
    const { store, engine } = openEngine(dir, config)
    // 造足够多的日志：每次 writeTurn 至少一条 write 记录。
    for (let i = 1; i <= 6; i += 1) writeOnce(engine, T0 + i * 1000, i)
    store.close()

    const entries = readLog(dir, config)
    assert.ok(entries.length <= 3, `环形截断后不该超过 3 条，实际 ${entries.length}`)
    assert.ok(entries.length > 0, '不能截成空文件')
    // 留下的必须是**最后**那几条：运维要看的永远是最近发生了什么。
    const last = entries[entries.length - 1]
    assert.ok(last !== undefined)
    assert.ok(last.at >= T0 + 5000, '保留的必须是最近的记录')
  })

  it('logMaxEntries 为 0 表示不限制', () => {
    const dir = tempDir()
    const config = mergeConfig(DEFAULT_CONFIG, { storage: { logMaxEntries: 0 } })
    const { store, engine } = openEngine(dir, config)
    for (let i = 1; i <= 6; i += 1) writeOnce(engine, T0 + i * 1000, i)
    store.close()

    const entries = readLog(dir, config)
    assert.ok(entries.length > 3, `不限制时不该截断，实际 ${entries.length} 条`)
  })
})

describe('FR-F1 · logs 子命令能读回日志', () => {
  it('能读回上一次运行落盘的日志', () => {
    // 只写不读等于没写。这条测的是**用户够不够得着**。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    writeOnce(engine)
    store.close()

    const result = runCli(['logs', '--data-dir', dir], { now: () => T0 })
    assert.equal(result.code, 0)
    assert.match(result.stdout, /\[write\]/u, '输出必须带日志种类')
    assert.match(result.stdout, /2023-11-15/u, '输出必须带可读时刻')
  })

  it('--json 输出机器可读的数组', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    writeOnce(engine)
    store.close()

    const result = runCli(['logs', '--data-dir', dir, '--json'], { now: () => T0 })
    assert.equal(result.code, 0)
    const payload = JSON.parse(result.stdout) as MemoryLogEntry[]
    assert.ok(Array.isArray(payload), '必须是数组')
    assert.ok(payload.length > 0)
    assert.ok(payload.some((entry) => entry.kind === 'write'))
  })

  it('--limit 只读最后 N 条', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    for (let i = 1; i <= 6; i += 1) writeOnce(engine, T0 + i * 1000, i)
    store.close()

    const all = JSON.parse(runCli(['logs', '--data-dir', dir, '--json'], { now: () => T0 }).stdout) as MemoryLogEntry[]
    const tail = JSON.parse(runCli(['logs', '--data-dir', dir, '--json', '--limit', '2'], { now: () => T0 }).stdout) as MemoryLogEntry[]
    assert.equal(tail.length, 2, '必须只返回 2 条')
    assert.deepEqual(tail, all.slice(-2), '必须是**最后** 2 条，不是前 2 条')
  })

  it('还没有日志时给出说明，而不是报错', () => {
    const dir = tempDir()
    const { store } = openEngine(dir)
    store.close()
    const result = runCli(['logs', '--data-dir', dir], { now: () => T0 })
    assert.equal(result.code, 0, '没日志不是错误')
    assert.match(result.stderr, /还没有诊断日志/u)
  })

  it('单行损坏不让整条命令失败', () => {
    // 进程被杀会留下写了一半的行。日志是旁路数据，
    // 一行坏了不该让人看不到其余记录。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    writeOnce(engine)
    store.close()

    const path = join(dir, DEFAULT_CONFIG.storage.logFile)
    const good = readFileSync(path, 'utf8')
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(path, `${good}{这行是坏的\n`, 'utf8')

    const result = runCli(['logs', '--data-dir', dir, '--json'], { now: () => T0 })
    assert.equal(result.code, 0, '坏行不能让命令失败')
    const payload = JSON.parse(result.stdout) as MemoryLogEntry[]
    assert.ok(payload.length > 0, '其余记录必须仍然读得出来')
  })
})
