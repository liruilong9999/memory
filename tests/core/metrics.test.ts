/**
 * FR-F3：指标与最小周报。
 *
 * ## 这组测试守的是什么
 *
 * 规格原文：「指标：召回次数、命中率、冲突数、库大小、注入 token」「有最小周报」。
 * 所以既要守**五个指标都真的有值**，也要守**周报能被读出来**——
 * 一个只在类型里存在的字段，和没有这个字段是一样的。
 *
 * ## 为什么必须从磁盘日志验证
 *
 * 指标曾经用进程内计数器（`this.recallCount`），重启归零。而周报天然跨天、
 * 跨进程——只用内存计数的实现在单进程测试里全绿，真实使用中永远是 0。
 * 所以核心用例是**关库重开**：重开后 `recalls` 必须还在。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import { aggregateMetrics, buildWeeklyReport } from '../../src/core/metrics.ts'
import type { MemoryLogEntry } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'

const T0 = Date.UTC(2023, 10, 15, 6, 0, 0)
const TZ = 'Asia/Shanghai'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-metrics-'))
  dirs.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不该让测试报红。
    }
  }
})

/** 构造一条 recall 日志。 */
function recallEntry(at: number, picked: number, tokens: number, conflicts = 0): MemoryLogEntry {
  return {
    kind: 'recall',
    at,
    summary: '召回',
    detail: {
      query: 'q',
      candidates: picked,
      picked: Array.from({ length: picked }, (_, i) => ({ id: `c${i}`, total: 0.5 })),
      tokens,
      empty: picked === 0,
      conflicts,
    },
  }
}

describe('FR-F3 · 指标聚合（纯函数）', () => {
  it('五个指标全部算出来，命中率的分母是召回次数', () => {
    const entries = [recallEntry(T0, 3, 100), recallEntry(T0 + 1, 0, 0), recallEntry(T0 + 2, 2, 50)]
    const metrics = aggregateMetrics(entries, 7)
    assert.equal(metrics.recalls, 3)
    // 3 次里 2 次有卡进焦点包。
    assert.equal(metrics.hitRate, 2 / 3)
    assert.equal(metrics.injectTokens, 150)
    assert.equal(metrics.active, 7, '库大小由调用方传入')
  })

  it('零召回时命中率为 0 而不是 NaN', () => {
    // 0/0 在 JS 里是 NaN，而 NaN 会一路污染到输出（`NaN%`），
    // 且 `NaN === 0` 为 false，任何「命中率为 0」的判断都会失效。
    const metrics = aggregateMetrics([], 0)
    assert.equal(metrics.recalls, 0)
    assert.equal(metrics.hitRate, 0)
    assert.ok(Number.isFinite(metrics.hitRate), '命中率必须是有限数')
  })

  it('冲突数从日志字段累加，不是靠猜', () => {
    const entries = [recallEntry(T0, 2, 10, 1), recallEntry(T0 + 1, 2, 10, 2)]
    assert.equal(aggregateMetrics(entries, 0).conflicts, 3)
  })

  it('只统计 recall 条目，write/consolidate 不污染召回指标', () => {
    const entries: MemoryLogEntry[] = [
      { kind: 'write', at: T0, summary: '写入', detail: { tokens: 999 } },
      recallEntry(T0 + 1, 1, 30),
      { kind: 'consolidate', at: T0 + 2, summary: '整理', detail: { tokens: 888 } },
    ]
    const metrics = aggregateMetrics(entries, 0)
    assert.equal(metrics.recalls, 1)
    assert.equal(metrics.injectTokens, 30, 'write/consolidate 的 tokens 不得算进注入量')
  })

  it('字段缺失或形状不对时按 0 处理，不抛异常', () => {
    // 日志是旁路数据：一行形状不对不该让整份周报失败。
    const entries: MemoryLogEntry[] = [
      { kind: 'recall', at: T0, summary: '坏记录', detail: {} },
      { kind: 'recall', at: T0 + 1, summary: '类型错', detail: { tokens: '100', empty: 'yes' } },
    ]
    const metrics = aggregateMetrics(entries, 0)
    assert.equal(metrics.recalls, 2)
    assert.equal(metrics.injectTokens, 0)
    assert.equal(metrics.conflicts, 0)
  })
})

describe('FR-F3 · 最小周报', () => {
  it('周报报出五个指标与一句结论', () => {
    const report = buildWeeklyReport({
      entries: [recallEntry(T0, 2, 100)],
      active: 5,
      archived: 2,
      since: T0,
      until: T0 + 6 * 24 * 60 * 60 * 1000,
      timeZone: 'Asia/Shanghai',
    })
    assert.match(report.text, /召回 1 次/u)
    assert.match(report.text, /命中率 100\.0%/u)
    assert.match(report.text, /注入 token 合计 100/u)
    assert.match(report.text, /活跃 5 张/u)
    assert.match(report.text, /归档 2 张/u)
    assert.match(report.text, /结论：召回工作正常/u)
    assert.equal(report.metrics.recalls, 1)
  })

  it('零召回时结论明说「无参考价值」，不拿 0 当「表现正常」', () => {
    // 这是最容易撒谎的地方：没有数据时输出「命中率 0%，一切正常」
    // 会让读者以为系统跑过了但全都落空。**没有数据和数据不好是两件事。**
    const report = buildWeeklyReport({
      entries: [], active: 3, archived: 0, since: T0, until: T0 + 1000, timeZone: 'Asia/Shanghai',
    })
    assert.match(report.text, /没有任何召回/u)
    assert.match(report.text, /不是「表现正常」/u)
  })

  it('命中率为 0 且确有召回时，结论指向真实问题', () => {
    const report = buildWeeklyReport({
      entries: [recallEntry(T0, 0, 0)], active: 3, archived: 0,
      since: T0, until: T0 + 1000, timeZone: 'Asia/Shanghai',
    })
    assert.match(report.text, /召回全部落空/u)
  })

  it('窗口起止日期按给定时区渲染，不是按 UTC', () => {
    // 用 UTC 渲染时 2023-11-15T06:00Z 显示成 11-15；
    // 上海时区是 11-15 14:00，同样 11-15。换一个跨日时刻才能区分：
    // 2023-11-15T20:00Z 在上海是 11-16。
    const at = Date.UTC(2023, 10, 15, 20, 0, 0)
    const shanghai = buildWeeklyReport({
      entries: [], active: 0, archived: 0, since: at, until: at, timeZone: 'Asia/Shanghai',
    })
    const utc = buildWeeklyReport({
      entries: [], active: 0, archived: 0, since: at, until: at, timeZone: 'UTC',
    })
    assert.match(shanghai.text, /2023-11-16/u)
    assert.match(utc.text, /2023-11-15/u)
  })
})

describe('FR-F3 · 指标必须跨进程存活（这是它和内存计数器的分界）', () => {
  it('关库重开后召回次数还在', () => {
    const dir = tempDir()

    // 第一个进程：写一轮、召回两次。
    const store1 = openStore({ dataDir: dir })
    const engine1 = new MemoryEngine({ store: store1, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    engine1.writeTurn({
      sessionId: 's1', turn: 1, step: 1, seq: 1, at: T0,
      userText: '生产环境部署必须先跑数据库迁移。昨天部署失败了，原因是数据库迁移没跑。',
      assistantText: '记住了。',
      domain: 'work',
    })
    engine1.recall('部署')
    engine1.recall('数据库')
    const before = engine1.metrics()
    // 前提断言：如果这里就是 0，后面的「重开后还在」毫无意义。
    assert.equal(before.recalls, 2, '前提：本进程内必须真的召回两次')
    assert.equal(before.source, 'log')
    store1.close()

    // 第二个进程：重新开库，什么都不做，直接看指标。
    const store2 = openStore({ dataDir: dir })
    const engine2 = new MemoryEngine({ store: store2, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    const after = engine2.metrics()
    assert.equal(after.recalls, 2, '召回次数必须跨进程存活——内存计数器会归零')
    assert.ok(after.injectTokens > 0, '注入 token 也必须跨进程存活')
    assert.equal(after.active, 2)
    store2.close()
  })

  it('注入 token 与日志里那条 recall 的 tokens 逐值一致', () => {
    // 只断言「大于 0」会替一个乱加的实现背书。逐值一致才证明
    // 聚合读的就是那条记录，而不是另算了一份。
    const dir = tempDir()
    const store = openStore({ dataDir: dir })
    const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    engine.writeTurn({
      sessionId: 's1', turn: 1, step: 1, seq: 1, at: T0,
      userText: '生产环境部署必须先跑数据库迁移。', assistantText: '好。', domain: 'work',
    })
    const result = engine.recall('部署')
    const metrics = engine.metrics()
    assert.equal(metrics.injectTokens, result.pack.tokens)
    store.close()
  })

  it('落盘关闭时退回内存计数，但 source 标成 memory 而不是假装是日志', () => {
    // 静默降级比崩溃更坏：读的是内存却报成「累计」，会让周报的数字
    // 在重启后莫名其妙变 0，而使用者以为它统计的是历史。
    const dir = tempDir()
    const store = openStore({ dataDir: dir })
    const engine = new MemoryEngine({
      store,
      config: { ...DEFAULT_CONFIG, storage: { ...DEFAULT_CONFIG.storage, logFile: '' } },
      timeZone: TZ,
      clock: () => T0,
    })
    engine.writeTurn({
      sessionId: 's1', turn: 1, step: 1, seq: 1, at: T0,
      userText: '生产环境部署必须先跑数据库迁移。', assistantText: '好。', domain: 'work',
    })
    engine.recall('部署')
    const metrics = engine.metrics()
    assert.equal(metrics.source, 'memory')
    assert.equal(metrics.recalls, 1)
    store.close()
  })
})
