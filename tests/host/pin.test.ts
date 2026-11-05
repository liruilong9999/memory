/**
 * FR-C3（人工豁免）的**生产入口**测试：`engine.pin` / `engine.unpin`。
 *
 * ## 这个文件守的是什么
 *
 * `src/consolidate/archive.ts` 里早就写着 `if (card.pinned) return false`，
 * `state.ts` 的 `put` 分支也早就能把整张卡（含 `pinned`）写进状态，
 * `MemoryFilter.pinned` 也早就能筛——**但 `src/` 里没有任何一处能把 `pinned`
 * 置成 `true`**。这是本仓库反复出现的同一个形态：
 * 「能力在、路径缺」（缺陷十七 / 缺陷三十三）。所以断言分两层：
 *
 * - 引擎层：`pin` / `unpin` 真的改变状态，且**真的写进了事件日志**；
 * - 端到端：钉住之后夜整理不再归档它，取消钉住之后重新归档它。
 *
 * ## 为什么必须从磁盘重放
 *
 * 「写进日志」与「只改了内存 Map」在内存视图上**完全一样**：两边
 * `inspect().pinned` 都是 `true`。只有关库重开才分得开。所以那条用例
 * 既重开库断言状态，又直接读 `.jsonl` 分片断言最后一条 `put` 里的
 * `op.card.pinned`，两条证据缺一不可——重开只证明「有个东西留下了」，
 * 读盘证明「留下的就是这次写的那条」。
 *
 * ## 两个方向都要测（AGENTS.md 第五节）
 *
 * | 方向 | 断言 | 漏掉会怎样 |
 * |---|---|---|
 * | 该丢弃的丢弃 | 已经钉住的卡再 pin 返回 false、**日志条数不变** | 重复操作堆日志 |
 * | 该更新的更新 | unpin 把 `pinned` 改回 false 且**日志条数 +1** | 取消钉住被静默丢弃 |
 *
 * 只测前者的话，一个「永远返回 false」的实现在所有「该丢弃」用例上全绿。
 *
 * ## 前提断言：不能绿在「它本来就不会被归档」上
 *
 * 「pin 后不被归档」这条断言有两个可能的绿法：一个是 pin 起了作用，
 * 另一个是这张卡**本来就不满足归档条件**。后者是假绿。所以每条归档用例
 * 前面都要先钉住前提：
 *
 * 1. 这张卡的 `strength` 确实低于 `config.forgetting.archiveThreshold`；
 * 2. `shouldArchive` 对**未钉住**的它返回 true；
 * 3. `applyArchiveRatio` 的上限不是 0（活跃卡不足 20 张而比例 5% 时，
 *    上限 `Math.floor(base * ratio)` 恒为 0，**夜整理一张都不会归档**——
 *    这条时间炸弹在本文件里被显式断言掉）；
 * 4. 同样的库、同样的时刻，**不 pin 的那一份确实被归档了**（对照组）。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { shouldArchive } from '../../src/consolidate/archive.ts'
import { DEFAULT_CONFIG, mergeConfig } from '../../src/core/config.ts'
import type { MemoryConfig } from '../../src/core/config.ts'
import type { JournalRecord } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import { makeCard } from '../store/helpers.ts'

/** 测试用固定时刻，避免时钟漂移让断言时红时绿。 */
const T0 = Date.UTC(2023, 10, 15, 6, 13, 0)

/** 一天的毫秒数：夜整理之间推进一天，让衰减有东西可做。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 测试时区。 */
const TZ = 'Asia/Shanghai'

/** 那张「不 pin 就会被归档」的卡的 id。 */
const WEAK_ID = 'pin-weak-00000001'

/** 归档用例里健康卡的数量。加上极弱卡一共 20 张，正好让归档上限 ≥ 1。 */
const HEALTHY_COUNT = 19

let root = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-pin-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 建一个本用例独占的子目录。 */
function caseDir(): string {
  return mkdtempSync(join(root, 'case-'))
}

/** 打开一个引擎 + store。 */
function openEngine(options: { dataDir: string; config?: MemoryConfig; clock?: () => number }): {
  store: ReturnType<typeof openStore>
  engine: MemoryEngine
} {
  const config = options.config ?? DEFAULT_CONFIG
  const store = openStore({ dataDir: options.dataDir, config })
  const engine = new MemoryEngine({
    store,
    config,
    timeZone: TZ,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  return { store, engine }
}

/**
 * 归档用例的配置：关掉摘要、蒸馏，并把去重阈值调成「不可能重复」。
 *
 * 为什么要关：夜整理是七步流水线，任何一步改变了卡片集合，都会间接改变
 * 归档那一步的**输入**。这条用例要隔离的是「pinned 是否挡住了归档」，
 * 所以其它会增删卡的步骤必须可预测。
 *
 * - **摘要**会新建 `summary` 卡，它也可能低于阈值，和极弱卡抢同一个归档名额
 *   （`applyArchiveRatio` 的上限只有 1），用例会时红时绿；
 * - **去重**更隐蔽：第一版夹具我写了 19 张「第 N 条健康的观察记录」，
 *   文本高度相似，被合并掉 18 张（合并掉的状态变成 archived）。于是第二次
 *   整理时活跃卡只剩 2 张，`Math.floor(2 * 0.05) = 0`，归档上限归零，
 *   极弱卡反而活了下来。**那次失败正是「活跃卡 < 20 ⇒ 上限 0」这条陷阱
 *   在真实运行里生效的现场记录**，不是测试写法的小毛病。
 *
 * 阈值调到 1 是「规则上不可能重复」，不是「刚好不重复」：相似度要精确等于 1
 * 才会合并，而两张不同的卡不可能。
 */
function archiveConfig(): MemoryConfig {
  return mergeConfig(DEFAULT_CONFIG, {
    consolidation: { summaryEnabled: false, distillEnabled: false },
    dedup: { duplicateSimilarity: 1 },
  })
}

/**
 * 造一个 20 张活跃卡的库：19 张健康 + 1 张极弱。
 *
 * 卡片类型一律用 `event`：`neverArchiveKinds` 里有 `feeling` / `promise` /
 * `fact` / `concept` / `experience`，用它们里的任何一个，`shouldArchive`
 * 都会在「类型豁免」那条分支提前返回 false，`pinned` 那条分支根本走不到。
 *
 * @param dir - 数据目录。
 * @param config - 库配置。
 * @returns 引擎、store 与极弱卡 id。
 */
function seedLibrary(dir: string, config: MemoryConfig): {
  store: ReturnType<typeof openStore>
  engine: MemoryEngine
} {
  const opened = openEngine({ dataDir: dir, config, clock: () => T0 })
  for (let i = 0; i < HEALTHY_COUNT; i += 1) {
    const text = `第 ${i} 条健康的观察记录，内容各不相同`
    opened.store.putCard(makeCard({
      id: `pin-healthy-${String(i).padStart(8, '0')}`,
      kind: 'event',
      text,
      normalized: text,
      strength: 0.9,
      entities: [],
      tags: [],
    }))
  }
  opened.store.putCard(makeCard({
    id: WEAK_ID,
    kind: 'event',
    text: '这条观察已经很久没有人用得上了',
    normalized: '这条观察已经很久没有人用得上了',
    strength: 0.02,
    entities: [],
    tags: [],
  }))
  return { store: opened.store, engine: opened.engine }
}

/**
 * 读出目录里全部日志记录（按分片顺序，按行解析）。
 *
 * 这是「落盘」这条断言的**唯一可信证据**：内存视图分不出「写进日志」与
 * 「只改了 Map」，而 `decodeRecord` 能解出来就说明字节真的在磁盘上。
 *
 * @param dir - 数据目录。
 * @returns 解析成功的日志记录。
 */
function readJournal(dir: string): JournalRecord[] {
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  const records: JournalRecord[] = []
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      records.push(JSON.parse(line) as JournalRecord)
    }
  }
  return records
}

describe('FR-C3 · 人工豁免必须可写（pin / unpin 生产入口）', () => {
  it('pin 把 pinned 写进日志：状态变了，且真的多了一条记录', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.5 }))
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, false, '前提：这张卡一开始没有被钉住')

    const written: JournalRecord[] = []
    opened.store.onRecord((record) => written.push(record))

    assert.equal(opened.engine.pin(WEAK_ID), true, 'pin 必须报告「真的写了」')
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, true)
    assert.equal(written.length, 1, 'pin 必须产生恰好一条日志记录')
    assert.equal(written[0]?.op.op, 'put')
    opened.store.close()
  })

  it('pin 不改变强度：它挡的是自动归档，不是衰减', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05 }))
    assert.equal(opened.engine.pin(WEAK_ID), true)

    const card = opened.engine.inspect(WEAK_ID)
    assert.equal(card?.strength, 0.05, 'pin 只翻 pinned，不该顺手动强度')
    opened.store.close()
  })

  it('刚写完就钉住（同一毫秒）也不会被幂等键吃掉', () => {
    const dir = caseDir()
    // 卡片 updatedAt 是 T0，时钟也被钉在 T0：只写 `updatedAt: now` 的实现
    // 会拼出与「写入这条卡」完全相同、甚至更早的幂等键指纹，日志层判重复、
    // 静默丢弃，pin 返回 false 而调用方以为钉住了。
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    const card = makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05, updatedAt: T0 })
    opened.store.putCard(card)
    assert.equal(opened.engine.inspect(WEAK_ID)?.updatedAt, T0, '前提：卡片的 updatedAt 就是当前时钟')

    assert.equal(opened.engine.pin(WEAK_ID), true, '同一毫秒内也必须能钉住')
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, true)
    assert.ok(
      (opened.engine.inspect(WEAK_ID)?.updatedAt ?? 0) > T0,
      'pin 必须让 updatedAt 严格变大，否则幂等键与上一条相同',
    )
    opened.store.close()
  })

  it('已经钉住的卡再 pin 返回 false，且不写新记录（该丢弃的丢弃）', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05 }))
    assert.equal(opened.engine.pin(WEAK_ID), true, '前提：第一次钉住成功')

    const written: JournalRecord[] = []
    opened.store.onRecord((record) => written.push(record))

    assert.equal(opened.engine.pin(WEAK_ID), false, '重复 pin 必须报告「什么都没做」')
    assert.equal(written.length, 0, '重复 pin 不能写无意义的记录（FR-A3 日志整洁性）')
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, true, '状态必须还是钉住的')
    opened.store.close()
  })

  it('unpin 把 pinned 改回 false 并写记录（该更新的更新）', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05, pinned: true }))
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, true, '前提：这张卡是钉住的')

    const written: JournalRecord[] = []
    opened.store.onRecord((record) => written.push(record))

    assert.equal(opened.engine.unpin(WEAK_ID), true, 'unpin 必须报告「真的写了」')
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, false)
    assert.equal(written.length, 1, 'unpin 必须产生恰好一条日志记录')
    opened.store.close()
  })

  it('本来就没钉住的卡 unpin 返回 false，且不写新记录', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05 }))

    const written: JournalRecord[] = []
    opened.store.onRecord((record) => written.push(record))

    assert.equal(opened.engine.unpin(WEAK_ID), false)
    assert.equal(written.length, 0)
    opened.store.close()
  })

  it('pin → unpin → pin 之后仍是钉住的（两个方向都走得通，不是单向开关）', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05 }))

    assert.equal(opened.engine.pin(WEAK_ID), true)
    assert.equal(opened.engine.unpin(WEAK_ID), true)
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, false, 'unpin 之后必须真的松开了')
    assert.equal(opened.engine.pin(WEAK_ID), true, '松开之后还能再钉住')
    assert.equal(opened.engine.inspect(WEAK_ID)?.pinned, true)
    opened.store.close()
  })

  it('对不存在的卡 pin / unpin 返回 false，且不写记录', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    const written: JournalRecord[] = []
    opened.store.onRecord((record) => written.push(record))

    assert.equal(opened.engine.pin('ffffffffffffffff'), false)
    assert.equal(opened.engine.unpin('ffffffffffffffff'), false)
    assert.equal(written.length, 0, '对不存在的卡不能留下记录')
    opened.store.close()
  })

  it('pin 必须落盘：关库重开后仍是钉住的（磁盘重放，不是内存视图）', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05 }))
    assert.equal(opened.engine.pin(WEAK_ID), true, '前提：钉住成功')
    opened.store.close()

    const reopened = openEngine({ dataDir: dir, clock: () => T0 + 5000 })
    assert.equal(
      reopened.engine.inspect(WEAK_ID)?.pinned, true,
      '重开后必须还是钉住的——否则 pin 只改了内存没进日志',
    )
    reopened.store.close()
  })

  it('磁盘上那条 put 的载荷里 pinned 就是 true（证明落的是这次写的字节）', () => {
    const dir = caseDir()
    const opened = openEngine({ dataDir: dir, clock: () => T0 })
    opened.store.putCard(makeCard({ id: WEAK_ID, kind: 'event', strength: 0.05 }))
    assert.equal(opened.engine.pin(WEAK_ID), true, '前提：钉住成功')
    opened.store.close()

    const records = readJournal(dir)
    assert.ok(records.length >= 2, `前提：磁盘上至少有写入与钉住两条记录（实际 ${records.length}）`)
    const puts = records.filter((record) => record.op.op === 'put')
    assert.ok(puts.length >= 2, '前提：至少两条 put（写入 + 钉住）')
    const last = puts[puts.length - 1]
    assert.ok(last !== undefined)
    if (last.op.op !== 'put') return
    assert.equal(last.op.card.id, WEAK_ID)
    assert.equal(
      last.op.card.pinned, true,
      '磁盘上最后一条 put 的卡片必须是钉住的——这是「真的落盘」而非「内存里改了」的直接证据',
    )
  })
})

describe('FR-C3 · 钉住之后夜整理不再归档它（端到端）', () => {
  it('前提：不 pin 的极弱卡确实会被夜整理归档', () => {
    const dir = caseDir()
    const config = archiveConfig()
    const { store, engine } = seedLibrary(dir, config)
    const weak = engine.inspect(WEAK_ID)
    assert.ok(weak !== undefined, '前提：极弱卡在库里')

    // —— 三条前提，缺一条这条用例就会绿在错误的原因上 ——
    assert.ok(
      weak.strength < config.forgetting.archiveThreshold,
      `前提：这张卡必须已经低于归档阈值（${weak.strength} < ${config.forgetting.archiveThreshold}）`,
    )
    assert.equal(
      shouldArchive(weak, config), true,
      '前提：未钉住时 shouldArchive 必须判它该归档，否则 pinned 那条分支根本没机会起作用',
    )
    assert.equal(store.count('active'), 20, '前提：活跃卡 20 张')
    assert.ok(
      Math.floor(store.count('active') * config.consolidation.maxArchiveRatio) >= 1,
      '前提：归档上限不能是 0——活跃卡不足 20 张而比例 5% 时 Math.floor(base * ratio) 恒为 0，夜整理一张都不会归档',
    )

    engine.consolidate(T0 + DAY_MS)
    assert.equal(
      engine.inspect(WEAK_ID)?.status, 'archived',
      '不 pin 的话它必须被归档——这是对照组',
    )
    store.close()
  })

  it('pin 之后同一张卡不再被归档', () => {
    const dir = caseDir()
    const config = archiveConfig()
    const { store, engine } = seedLibrary(dir, config)
    const weak = engine.inspect(WEAK_ID)
    assert.ok(weak !== undefined)
    assert.ok(
      weak.strength < config.forgetting.archiveThreshold,
      '前提：这张卡确实低于归档阈值（不是「本来就安全」）',
    )
    assert.equal(shouldArchive(weak, config), true, '前提：未钉住时它该被归档')
    assert.ok(Math.floor(store.count('active') * config.consolidation.maxArchiveRatio) >= 1, '前提：归档上限 ≥ 1')

    assert.equal(engine.pin(WEAK_ID), true, '前提：钉住成功')
    engine.consolidate(T0 + DAY_MS)

    assert.equal(
      engine.inspect(WEAK_ID)?.status, 'active',
      '钉住之后必须还活着——否则 pin 没有真的挡住自动归档',
    )
    // 同一次整理里其它判据照常生效：健康卡不该被误伤，否则「没归档」可能
    // 只是整个归档步骤没跑。
    assert.equal(store.count('archived'), 0, '库里不该有别的卡被归档')
    store.close()
  })

  it('unpin 之后重新受自动归档管辖（豁免可撤销）', () => {
    const dir = caseDir()
    const config = archiveConfig()
    const { store, engine } = seedLibrary(dir, config)
    assert.equal(engine.pin(WEAK_ID), true, '前提：钉住成功')

    engine.consolidate(T0 + DAY_MS)
    assert.equal(engine.inspect(WEAK_ID)?.status, 'active', '前提：钉住期间没被归档')

    assert.equal(engine.unpin(WEAK_ID), true, '前提：取消钉住成功')
    engine.consolidate(T0 + 2 * DAY_MS)

    assert.equal(
      engine.inspect(WEAK_ID)?.status, 'archived',
      '取消钉住之后它必须重新落回自动归档的管辖——豁免是可撤销的，不是永久免疫',
    )
    store.close()
  })
})
