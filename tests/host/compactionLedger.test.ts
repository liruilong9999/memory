/**
 * 压缩台账单测（P1-6 的地基）。
 *
 * 台账是压缩回填（`docs/2-DSH宿主约束.md:100` 的第 ② 步）唯一的状态载体，
 * 它同时承担两件事：**跨进程幂等**与**可观测**。这里的用例分成五组：
 *
 * 1. 读盘容错：文件不存在、JSON 坏掉、版本不认识、单条损坏——**都不抛错**。
 * 2. 幂等键：`sessionId + compactionId`，两个方向都测。
 * 3. FIFO 截断：保留**最后** N 条（写反了会留住最旧的、扔掉最新的）。
 * 4. 落盘原子性 + 跨进程重放（必须从磁盘读回来，不能只看内存）。
 * 5. 观测视图：`summarizeCompactions` 的每个字段都由规则决定。
 *
 * 反向验证提醒：`readCompactionLedger` 与 `writeCompactionLedger` 必须成对
 * 测——只测「写得进去」的话，一个永远返回 `[]` 的读实现也能让「写入成功」
 * 看起来绿；只测「读得出来」的话，一个不落盘的写实现会让「重启后还在」
 * 绿在内存里。
 *
 * @module tests/host/compactionLedger.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  COMPACTION_LEDGER_DIR, COMPACTION_LEDGER_VERSION, LEDGER_FILE_NAME,
  compactionKey, compactionLedgerDir, compactionLedgerPath, findCompactionRecord,
  readCompactionLedger, summarizeCompactions, upsertCompactionRecord, writeCompactionLedger,
} from '../../src/host/engine/compactionLedger.ts'
import type { CompactionRecord } from '../../src/host/engine/compactionLedger.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

const T0 = 1_700_000_000_000
const NL = String.fromCharCode(10)

const tempDirs: string[] = []

/** 建临时目录并登记清理。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-ledger-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/**
 * 造一条台账记录。
 *
 * 刻意**不带默认的 `flushedCards`**：那个字段的语义（累计 vs 最近一次）是
 * 一条独立的判据，默认成 1 会让写错的实现看不出来。
 *
 * @param over - 覆盖字段。
 * @returns 台账记录。
 */
function makeRecord(over: Partial<CompactionRecord> = {}): CompactionRecord {
  return {
    sessionId: over.sessionId ?? 'sess-1',
    compactionId: over.compactionId ?? 'c1',
    at: over.at ?? T0,
    shadowedRange: over.shadowedRange ?? { start: 1, end: 3 },
    shadowedSeqs: over.shadowedSeqs ?? [1, 2, 3],
    shadowedTokenCount: over.shadowedTokenCount ?? 120,
    flushedCards: over.flushedCards ?? 0,
    deliveries: over.deliveries ?? 1,
  }
}

/** 把台账文件写成一个「坏掉的」形态，用于测读盘容错。 */
function writeRawLedger(dir: string, text: string): void {
  mkdirSync(compactionLedgerDir(dir), { recursive: true })
  writeFileSync(compactionLedgerPath(dir), text, 'utf8')
}

describe('压缩台账的路径约定（P1-6）', () => {
  it('落在 dataDir/compaction/ledger.json，不是顶层', () => {
    const dir = tempDir()
    // 判据是「顶层只有事件日志分片与 meta.json」——`src/store/configLedger.ts`
    // 的模块注释写了这条约定（教训见 docs/7 真缺陷十一）。台账落顶层会让任何
    // 按扩展名扫顶层的工具把它当别的东西。
    assert.equal(compactionLedgerDir(dir), join(dir, COMPACTION_LEDGER_DIR))
    assert.equal(compactionLedgerPath(dir), join(dir, COMPACTION_LEDGER_DIR, LEDGER_FILE_NAME))
    assert.ok(
      compactionLedgerPath(dir).startsWith(join(dir, COMPACTION_LEDGER_DIR)),
      '台账必须在子目录里，不能与事件日志分片同层',
    )
  })

  it('文件名以 .json 结尾（不会被「按 .jsonl 扫顶层」的工具误认）', () => {
    assert.ok(LEDGER_FILE_NAME.endsWith('.json'))
    assert.ok(!LEDGER_FILE_NAME.endsWith('.jsonl'), '.jsonl 会被当成事件日志分片')
  })
})

describe('压缩台账的读盘容错（绝不抛错）', () => {
  it('文件不存在时返回空台账', () => {
    const dir = tempDir()
    // 前提：确实没有那个文件。没有这条，「读不存在」可能绿在别的原因上。
    assert.ok(!existsSync(compactionLedgerPath(dir)), '前提：文件确实不存在')
    assert.deepEqual(readCompactionLedger(dir), [])
  })

  it('JSON 坏掉时返回空台账而不是抛错', () => {
    const dir = tempDir()
    writeRawLedger(dir, '{ 这不是 JSON')
    assert.doesNotThrow(() => readCompactionLedger(dir))
    assert.deepEqual(readCompactionLedger(dir), [])
  })

  it('版本号不认识时重置整份台账（降级读未知格式更危险）', () => {
    const dir = tempDir()
    writeRawLedger(dir, `${JSON.stringify({
      v: COMPACTION_LEDGER_VERSION + 1,
      records: [makeRecord()],
    })}${NL}`)
    // 一条完全合法的记录，只因文件版本不认识就必须整份丢弃：让旧代码
    // 按自己的理解读新格式，会把不认识的字段当成「没有」再写回去。
    assert.deepEqual(readCompactionLedger(dir), [])
  })

  it('单条记录不合法只跳过那一条，其余照读', () => {
    const dir = tempDir()
    writeRawLedger(dir, `${JSON.stringify({
      v: COMPACTION_LEDGER_VERSION,
      records: [
        makeRecord({ compactionId: 'good-1' }),
        { compactionId: 'broken' }, // 缺一堆必填字段
        makeRecord({ compactionId: 'good-2' }),
      ],
    })}${NL}`)
    const records = readCompactionLedger(dir)
    // 与 `coerceMeta` 的「任何不合法即整体重置」刻意不同：台账是列表，
    // 跳过一条的含义明确且局部（代价是那一条的幂等记忆丢失）。
    assert.deepEqual(records.map((record) => record.compactionId), ['good-1', 'good-2'])
  })

  it('写读往返：所有字段都不丢（含 null 的 shadowedRange）', () => {
    const dir = tempDir()
    // `shadowedRange: null` 是**合法**值（载荷缺范围），不是「没有这个字段」。
    // 它必须能往返，否则「缺范围」会被读成「范围是 0/0」。
    const records = [
      makeRecord({ compactionId: 'a', shadowedRange: null, flushedCards: 2 }),
      makeRecord({ compactionId: 'b', shadowedRange: { start: 9, end: 4 }, flushedCards: 3 }),
    ]
    writeCompactionLedger(dir, records)
    assert.deepEqual(readCompactionLedger(dir), records)
  })

  it('不校验 start <= end（那会拒掉宿主的合法数据）', () => {
    const dir = tempDir()
    // 宿主源码明确写：一次 replace 把新摘要节点放到旧区间位置后，start 可以
    // 大于 end。若这里加一条 `start <= end` 的校验，这条记录会被静默丢掉。
    writeCompactionLedger(dir, [makeRecord({ shadowedRange: { start: 9, end: 4 } })])
    const records = readCompactionLedger(dir)
    assert.equal(records.length, 1)
    assert.deepEqual(records[0]?.shadowedRange, { start: 9, end: 4 })
  })
})

describe('压缩台账的幂等键（两个方向都要测）', () => {
  it('键包含 sessionId 与 compactionId 两者', () => {
    const a = compactionKey({ sessionId: 's-1', compactionId: 'c-1' })
    const b = compactionKey({ sessionId: 's-2', compactionId: 'c-1' })
    const c = compactionKey({ sessionId: 's-1', compactionId: 'c-2' })
    // 三个键互不相同：任一侧变化都必须产生新键，否则「另一个会话的同名压缩」
    // 或「同一会话的下一次压缩」会被当成重复投递而静默丢弃。
    assert.notEqual(a, b, 'sessionId 必须影响键')
    assert.notEqual(a, c, 'compactionId 必须影响键')
  })

  it('键不受分隔符注入影响（NUL 分隔保证成分无法互相冒充）', () => {
    // 拼键时若直接用 `a + b`，`{s:'ab', c:'c'}` 与 `{s:'a', c:'bc'}` 会撞。
    // 用 NUL（不会出现在 id 里）分隔才安全。
    const a = compactionKey({ sessionId: 'ab', compactionId: 'c' })
    const b = compactionKey({ sessionId: 'a', compactionId: 'bc' })
    assert.notEqual(a, b, '拼接必须无歧义')
  })

  it('该丢弃的丢弃：同键写两次，台账只有一条', () => {
    const first = upsertCompactionRecord([], makeRecord(), 128)
    const second = upsertCompactionRecord(first, makeRecord({ at: T0 + 1 }), 128)
    assert.equal(second.length, 1, '同一个 compactionId 两次投递只能留一条')
  })

  it('该更新的更新：同键不同内容写两次，读到的是新的', () => {
    const first = upsertCompactionRecord([], makeRecord({ flushedCards: 3 }), 128)
    const second = upsertCompactionRecord(
      first,
      makeRecord({ at: T0 + 500, shadowedSeqs: [7, 8], flushedCards: 5, deliveries: 2 }),
      128,
    )
    assert.equal(second.length, 1)
    const record = second[0]
    // 这一半最容易被漏：「该丢弃的丢弃」测绿了，更新被静默丢弃照样绿。
    // 真实缺陷（`deriveIdempotencyKey` 的 `edge` / `put` 分支）都是这一半。
    assert.equal(record?.at, T0 + 500, '时刻必须更新成最新一次')
    assert.deepEqual(record?.shadowedSeqs, [7, 8], '被吞区间必须更新')
    assert.equal(record?.flushedCards, 5, '回填数必须更新')
    assert.equal(record?.deliveries, 2, '投递次数必须更新')
  })

  it('更新后该记录排到末尾（列表顺序 = 最近投递序）', () => {
    let records = upsertCompactionRecord([], makeRecord({ compactionId: 'c1', at: T0 }), 128)
    records = upsertCompactionRecord(records, makeRecord({ compactionId: 'c2', at: T0 + 1 }), 128)
    // 现在回头更新 c1：它必须排到 c2 之后，否则 `summarizeCompactions` 取
    // 末条当「最近一次」就会报出 c2，与「c1 刚刚才被投递」矛盾。
    records = upsertCompactionRecord(records, makeRecord({ compactionId: 'c1', at: T0 + 2 }), 128)
    assert.deepEqual(records.map((record) => record.compactionId), ['c2', 'c1'])
  })

  it('findCompactionRecord 按键查找，找不到返回 undefined', () => {
    const records = [makeRecord({ sessionId: 's-1', compactionId: 'c1' })]
    assert.notEqual(findCompactionRecord(records, 's-1', 'c1'), undefined)
    assert.equal(findCompactionRecord(records, 's-2', 'c1'), undefined)
    assert.equal(findCompactionRecord(records, 's-1', 'c2'), undefined)
  })
})

describe('压缩台账的 FIFO 截断（保留最后 N 条）', () => {
  it('超出上限时丢掉最旧的、留下最新的', () => {
    let records: CompactionRecord[] = []
    for (let index = 0; index < 5; index += 1) {
      records = upsertCompactionRecord(
        records,
        makeRecord({ compactionId: `c${index}`, at: T0 + index }),
        3,
      )
    }
    // 写成 `slice(0, N)` 会留下 c0/c1/c2（最旧的三条），与「记住最近发生了什么」
    // 正好相反——而两者长度相同，只断言长度是测不出来的。
    assert.deepEqual(
      records.map((record) => record.compactionId),
      ['c2', 'c3', 'c4'],
      '必须留下最新的三条，不是最旧的三条',
    )
  })

  it('恰好等于上限时不截断', () => {
    let records: CompactionRecord[] = []
    for (let index = 0; index < 3; index += 1) {
      records = upsertCompactionRecord(records, makeRecord({ compactionId: `c${index}` }), 3)
    }
    assert.equal(records.length, 3)
  })

  it('上限 <= 0 时不限制（校验层已挡掉 0，这里仍容错不炸）', () => {
    let records: CompactionRecord[] = []
    for (let index = 0; index < 5; index += 1) {
      records = upsertCompactionRecord(records, makeRecord({ compactionId: `c${index}` }), 0)
    }
    assert.equal(records.length, 5)
  })

  it('不修改入参数组', () => {
    const original = [makeRecord({ compactionId: 'c1' })]
    const frozen = [...original]
    upsertCompactionRecord(original, makeRecord({ compactionId: 'c2' }), 128)
    // 纯函数：调用方可能还持有旧数组（引擎把它当字段，改写会让「落盘失败
    // 就回滚」之类的逻辑失去依据）。
    assert.deepEqual(original, frozen)
  })
})

describe('压缩台账的落盘（跨进程的全部依据）', () => {
  it('写入后文件真的出现在磁盘上', () => {
    const dir = tempDir()
    writeCompactionLedger(dir, [makeRecord()])
    assert.ok(existsSync(compactionLedgerPath(dir)), '文件必须真的被创建')
    const raw = readFileSync(compactionLedgerPath(dir), 'utf8')
    // 前提断言：文件里必须是能被解出记录的形态，不是空串。
    assert.match(raw, /compactionId/u)
    assert.deepEqual(readCompactionLedger(dir).length, 1)
  })

  it('覆盖写是原子的（临时文件不残留）', () => {
    const dir = tempDir()
    writeCompactionLedger(dir, [makeRecord({ compactionId: 'c1' })])
    writeCompactionLedger(dir, [makeRecord({ compactionId: 'c2' })])
    // 原子写走 tmp + rename：rename 成功后不该留下 `.tmp` 残留，否则目录会
    // 随时间堆满垃圾，而没有任何报错。
    assert.ok(!existsSync(`${compactionLedgerPath(dir)}.tmp`), '临时文件必须已被 rename 掉')
    assert.deepEqual(readCompactionLedger(dir).map((record) => record.compactionId), ['c2'])
  })

  it('跨进程重放：新读一次（模拟重启）仍能认出幂等键', () => {
    const dir = tempDir()
    writeCompactionLedger(dir, [makeRecord({ sessionId: 's-9', compactionId: 'c-restart' })])
    // 模拟进程重启：这里**只靠磁盘**，没有任何进程内状态。
    const reopened = readCompactionLedger(dir)
    assert.notEqual(
      findCompactionRecord(reopened, 's-9', 'c-restart'),
      undefined,
      '重启后必须仍能认出同一个 compactionId——这是跨进程幂等的全部依据',
    )
  })
})

describe('压缩台账的观测视图（FR-F1）', () => {
  it('空台账返回零值形状，lastAt 为 null', () => {
    const stats = summarizeCompactions([])
    assert.equal(stats.count, 0)
    // `null` 而不是 0：`0` 是 1970-01-01，与「从未压缩过」是两件事
    // （`src/store/meta.ts` 的 `lastConsolidationAt` 注释记过同一处）。
    assert.equal(stats.lastAt, null)
    assert.equal(stats.lastShadowedRange, null)
    assert.deepEqual(stats.lastShadowedSeqs, [])
    assert.equal(stats.lastShadowedTokens, 0)
    assert.equal(stats.lastFlushedCards, 0)
    assert.equal(stats.shadowedSeqsTotal, 0)
    assert.equal(stats.duplicateDeliveries, 0)
  })

  it('取末条作为「最近一次」，不是首条', () => {
    const records = [
      makeRecord({ compactionId: 'c1', at: T0, shadowedSeqs: [1], shadowedTokenCount: 10 }),
      makeRecord({ compactionId: 'c2', at: T0 + 5, shadowedSeqs: [2, 3], shadowedTokenCount: 20 }),
    ]
    const stats = summarizeCompactions(records)
    // 取错端会让所有观测数字整体落后一次压缩，而且看起来完全正常。
    assert.equal(stats.lastAt, T0 + 5)
    assert.deepEqual(stats.lastShadowedSeqs, [2, 3])
    assert.equal(stats.lastShadowedTokens, 20)
  })

  it('shadowedSeqsTotal 是各次长度之和，不是去重后的集合大小', () => {
    const records = [
      makeRecord({ compactionId: 'c1', shadowedSeqs: [1, 2, 3] }),
      makeRecord({ compactionId: 'c2', shadowedSeqs: [3, 4] }),
    ]
    // 两次都吞了 3 号节点（重复压缩同一片区域是正常现象），求和是 5 而不是 4。
    assert.equal(summarizeCompactions(records).shadowedSeqsTotal, 5)
  })

  it('duplicateDeliveries 数的是 deliveries > 1 的记录条数', () => {
    const records = [
      makeRecord({ compactionId: 'c1', deliveries: 1 }),
      makeRecord({ compactionId: 'c2', deliveries: 2 }),
      makeRecord({ compactionId: 'c3', deliveries: 3 }),
    ]
    assert.equal(summarizeCompactions(records).duplicateDeliveries, 2)
  })

  it('lastShadowedSeqs 是副本，改它不会污染台账记录', () => {
    const records = [makeRecord({ shadowedSeqs: [1, 2] })]
    const stats = summarizeCompactions(records)
    stats.lastShadowedSeqs.push(999)
    // 观测视图与状态必须隔离：否则读一次 `health()` 就能改坏台账，
    // 而那是一次纯读操作。
    assert.deepEqual(records[0]?.shadowedSeqs, [1, 2])
  })
})
