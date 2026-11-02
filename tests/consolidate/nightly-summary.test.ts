/**
 * 摘要与蒸馏在夜整理里的端到端行为（FR-D4 / FR-C5 / ST-1）。
 *
 * 与 `summarize.test.ts` 的分工：那个文件测纯函数「算得对不对」，
 * 这个文件测**接进夜整理之后是否真的落库、重放后是否还是同一张卡**。
 *
 * 最关键的一条是重放断言：日志写的是 `kind: 'summary'`，重放出来就必须
 * 还是 `summary`。`coerceCard` 曾在 kind 白名单里把未知值降级成 `fact`，
 * 导致「写 A 得 B」而事后无从发现（ST-1）。新增一个 kind 就必须补这条。
 *
 * @module tests/consolidate/nightly-summary.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runConsolidation } from '../../src/consolidate/nightly.ts'
import { applyRecord, createEmptyState } from '../../src/store/state.ts'
import { compressionRatio, summaryKeyOf, summaryLevelOf } from '../../src/consolidate/summarize.ts'
import type { JournalOp, MemoryCard } from '../../src/core/types.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

/** 测试时区：东八区，让自然日边界与 UTC 不同。 */
const TZ = 'Asia/Shanghai'

/** 基准时刻：东八区 2023-11-15 06:13。 */
const T0 = 1_700_000_000_000

/**
 * 用真实数据面重放操作序列，得到最终卡片集合。
 *
 * `at` 从 `op.at` 推导而不是硬编码：`state.ts` 的 `revise`/`archive`/`restore`
 * 用 `record.at`，测试里若硬写别的时刻，测出来的就不是真实行为。
 *
 * @param cards - 初始卡片。
 * @param ops - 操作序列。
 * @returns id 到卡片的映射。
 */
function replay(cards: readonly MemoryCard[], ops: readonly JournalOp[]): Map<string, MemoryCard> {
  const state = createEmptyState()
  for (const card of cards) state.cards.set(card.id, card)
  ops.forEach((op, index) => {
    applyRecord(state, {
      v: 1,
      seq: index,
      at: opAtOf(op),
      idempotencyKey: `replay:${index}`,
      op,
    })
  })
  return state.cards
}

/**
 * 从操作里取它自带的时间戳，缺省用基准时刻。
 *
 * @param op - 日志操作。
 * @returns 毫秒时间戳。
 */
function opAtOf(op: JournalOp): number {
  if (op.op === 'put') return op.card.updatedAt
  if (op.op === 'archive' || op.op === 'restore' || op.op === 'revise' || op.op === 'touch') return op.at
  return T0 + DAY_MS
}

/**
 * 造一天的事件卡，文本足够长且**彼此不同**。
 *
 * 文本必须真正不同，不能是同一个模板换数字：夜整理先去重再摘要，
 * 6 条近乎相同的记录会被合并成 1 条，摘要来源随之不够长而不产出。
 * 这不是摘要的缺陷——那天确实只有一件事——但会让测试测不到摘要。
 *
 * @param dayOffset - 相对基准日偏移多少天。
 * @param count - 张数。
 * @returns 卡片数组。
 */
function dayCards(dayOffset: number, count: number): MemoryCard[] {
  const base = T0 + dayOffset * DAY_MS
  // 每天用一批语义上互不相干的主题，模拟真实一天里的多件事。
  // 主题池必须够大：跨天撞上同一个主题会被去重合并掉，后面的天就没卡可摘要。
  const topics = [
    { text: '上午把摘要的字符预算算错了，导致周摘要比日摘要还长，后来改成层级递减', tags: ['摘要'], entities: ['摘要', '预算'] },
    { text: '下午和产品对了需求边界，确认自然日按用户所在时区划分而不是 UTC', tags: ['需求'], entities: ['时区', '需求'] },
    { text: '晚上排查一个召回排序问题，发现目标文本为空时归一化分母被错误地缩小了', tags: ['召回'], entities: ['召回', '排序'] },
    { text: '顺手补了三条缺失的单测，覆盖归档不改变强度这条容易退化的约束', tags: ['测试'], entities: ['归档', '测试'] },
    { text: '读了一遍架构文档，发现数据流图里没有画出感受蒸馏那条路径，需要补上', tags: ['文档'], entities: ['文档', '蒸馏'] },
    { text: '重构了事件日志的重放入口，把两处手写字段语义合并成一处，减少漂移点', tags: ['重构'], entities: ['事件日志', '重放'] },
    { text: '给命令行加了 health 子命令，用来一眼看出库里的卡片分布与归档比例', tags: ['命令行'], entities: ['命令行', '健康检查'] },
    { text: '复查了并发写入的保护逻辑，确认单写者假设写在了显眼的位置', tags: ['并发'], entities: ['并发', '写入'] },
    { text: '在纸上看了一遍遗忘曲线，发现半衰期对情绪卡的双倍加成没有写进文档', tags: ['遗忘'], entities: ['半衰期', '情绪'] },
    { text: '把焦点包的 token 预算重新算了一遍，发现头尾固定开销一直没被计入', tags: ['焦点包'], entities: ['焦点包', '预算'] },
    { text: '给到期提醒补了跨时区的换算，之前用本地时间直接比较是错的', tags: ['提醒'], entities: ['提醒', '时区'] },
    { text: '整理了幂等键的生成规则，确认同一轮对话重放不会重复落卡', tags: ['幂等'], entities: ['幂等', '重放'] },
    { text: '检查图谱的七种边，发现只有三种有真实产出，其余只是声明', tags: ['图谱'], entities: ['图谱', '边'] },
    { text: '给抽取层加了实体归并，避免同一件事因为措辞不同被拆成两张卡', tags: ['抽取'], entities: ['抽取', '实体'] },
    { text: '复盘了一次误归档事故，根因是把从没被访问过的卡当成了不重要', tags: ['归档'], entities: ['归档', '访问'] },
    { text: '给配置校验补了层级上限的交叉检查，防止层级越高摘要反而越长', tags: ['配置'], entities: ['配置', '校验'] },
  ]
  return Array.from({ length: count }, (_, index) => {
    // 按天错开主题，且同一天内不复用：否则不同天会撞上同一个主题文本，
    // 被去重跨天合并掉，后面的天就没有卡可以摘要了（实测合并 7 组只剩 1 天）。
    const topic = topics[(dayOffset * count + index) % topics.length]!
    return makeCard({
      id: `d${dayOffset}-c${index}`,
      kind: 'event',
      createdAt: base + index * 3_600_000,
      updatedAt: base + index * 3_600_000,
      emotional: 0.2,
      text: `第 ${index} 条：${topic.text}`,
      tags: topic.tags,
      entities: topic.entities,
    })
  })
}

describe('夜整理产出摘要（FR-D4 / 起源 L27）', () => {
  it('一天的卡产出日摘要，报告里 summarized 计数正确', () => {
    const config = makeConfig()
    const cards = dayCards(0, 6)
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const summaries = result.cards.filter((card) => card.kind === 'summary')
    assert.equal(summaries.length, 1, '应产出 1 张日摘要')
    assert.equal(result.report.summarized, 1)
    assert.equal(summaryLevelOf(summaries[0]!), 'daily')
    assert.equal(summaryKeyOf(summaries[0]!), '2023-11-15')
  })

  it('summary 卡经真实 applyRecord 重放后仍是 summary（ST-1）', () => {
    const config = makeConfig()
    const cards = dayCards(0, 6)
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const replayed = replay(cards, result.ops)
    const summaries = [...replayed.values()].filter((card) => card.kind === 'summary')
    assert.equal(summaries.length, 1, '重放后摘要卡必须存在')
    // 这是本文件最重要的一条：日志写 summary，重放出来必须还是 summary。
    assert.equal(summaries[0]!.kind, 'summary', 'kind 不得在投影层被降级')
    assert.equal(summaryLevelOf(summaries[0]!), 'daily', '层级信息必须能从重放结果读回')
  })

  it('返回的 cards 与重放结果逐字段一致（P2 日志是唯一真相源）', () => {
    const config = makeConfig()
    const cards = dayCards(0, 6)
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const replayed = replay(cards, result.ops)
    assert.equal(result.cards.length, replayed.size, '卡片数量必须一致')
    for (const card of result.cards) {
      const other = replayed.get(card.id)
      assert.notEqual(other, undefined, `重放缺少卡片 ${card.id}`)
      assert.deepEqual(card, other, `卡片 ${card.id} 的返回值与重放结果不一致`)
    }
  })

  it('日摘要真的压缩了来源（压缩比断言）', () => {
    const config = makeConfig()
    const cards = dayCards(0, 10)
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const summary = result.cards.find((card) => card.kind === 'summary')!
    // 来源只算事件卡：摘要不压摘要。
    const sources = cards.filter((card) => card.kind !== 'summary')
    const ratio = compressionRatio(summary, sources)
    assert.ok(
      ratio < config.consolidation.summaryTargetRatio,
      `压缩比 ${ratio.toFixed(3)} 应低于 ${config.consolidation.summaryTargetRatio}`,
    )
  })

  it('summaryEnabled 关闭时不产出摘要', () => {
    const config = makeConfig({ consolidation: { summaryEnabled: false } })
    const result = runConsolidation({ cards: dayCards(0, 6) }, config, T0 + DAY_MS, TZ)
    assert.equal(result.cards.filter((card) => card.kind === 'summary').length, 0)
    assert.equal(result.report.summarized, 0)
  })

  it('重复整理不重复产出摘要（幂等）', () => {
    const config = makeConfig()
    const cards = dayCards(0, 6)
    const first = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const firstCount = first.cards.filter((card) => card.kind === 'summary').length
    assert.equal(firstCount, 1)

    const second = runConsolidation(
      { cards: first.cards, edges: first.edges }, config, T0 + 2 * DAY_MS, TZ,
    )
    const secondCount = second.cards.filter((card) => card.kind === 'summary').length
    assert.equal(secondCount, 1, '重复整理不应堆出重复摘要')
    assert.equal(second.report.summarized, 0, '第二轮不该产出新摘要')
  })

  it('多天的事件卡产出日摘要与周摘要（层级在同一轮内建成）', () => {
    const config = makeConfig()
    // 2023-11-13 是周一，连续 3 天。用 dayCards 保证每天内容互不相同，
    // 否则去重会把它们并成一张，摘要来源不够长。
    const monday = Date.UTC(2023, 10, 13, 6)
    const cards: MemoryCard[] = []
    for (let day = 0; day < 3; day += 1) {
      cards.push(...dayCards(day, 5).map((card, index) => makeCard({
        ...card,
        id: `w${day}-${index}`,
        createdAt: monday + day * DAY_MS + index * 3_600_000,
        updatedAt: monday + day * DAY_MS + index * 3_600_000,
      })))
    }
    const result = runConsolidation({ cards }, config, monday + 4 * DAY_MS, TZ)
    const dailies = result.cards.filter((card) => summaryLevelOf(card) === 'daily')
    const weeklies = result.cards.filter((card) => summaryLevelOf(card) === 'weekly')
    assert.equal(dailies.length, 3, '应产出 3 张日摘要')
    assert.equal(weeklies.length, 1, '应产出 1 张周摘要')

    // 周摘要必须比三张日摘要的总和显著更短。
    const dailyTotal = dailies.reduce((acc, card) => acc + [...card.text].length, 0)
    const weeklyChars = [...weeklies[0]!.text].length
    assert.ok(
      weeklyChars < dailyTotal,
      `周摘要 ${weeklyChars} 字应小于 3 张日摘要总和 ${dailyTotal} 字`,
    )
  })
})

describe('夜整理产出感受（起源 L11 / FR-C5）', () => {
  /**
   * 造一组「反复发生且带情绪」的卡。
   *
   * 文本刻意写得**不相似**，避免被去重合并掉——去重会把「反复」的证据消灭。
   *
   * @returns 卡片数组。
   */
  function repeatedStress(): MemoryCard[] {
    return [
      makeCard({
        id: 'e1', kind: 'event', createdAt: T0, updatedAt: T0, emotional: 0.8,
        text: '上线前又发现严重问题，压力大到睡不着', entities: ['上线'],
      }),
      makeCard({
        id: 'e2', kind: 'event', createdAt: T0 + 3_600_000, updatedAt: T0 + 3_600_000, emotional: 0.75,
        text: '发布窗口被推迟，整晚都在排查', entities: ['上线'],
      }),
      makeCard({
        id: 'e3', kind: 'event', createdAt: T0 + 7_200_000, updatedAt: T0 + 7_200_000, emotional: 0.7,
        text: '上线终于成功但已精疲力尽', entities: ['上线'],
      }),
    ]
  }

  it('反复的强情绪主题蒸馏出感受卡，并带 distills 边', () => {
    const config = makeConfig()
    const result = runConsolidation({ cards: repeatedStress() }, config, T0 + DAY_MS, TZ)
    const feelings = result.cards.filter((card) => card.kind === 'feeling')
    assert.equal(feelings.length, 1, '应产出 1 张感受卡')
    assert.equal(result.report.distilled, 1)

    const distillEdgesOfFeeling = result.edges.filter((edge) => edge.relation === 'distills')
    assert.ok(distillEdgesOfFeeling.length > 0, 'distills 边必须真实产出（起源 L15）')
    for (const edge of distillEdgesOfFeeling) {
      assert.equal(edge.from, feelings[0]!.id, '方向：感受 → 来源事件')
    }
  })

  it('感受卡在重放后仍是 feeling，且 distills 边也在重放结果里', () => {
    const config = makeConfig()
    const cards = repeatedStress()
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const replayed = replay(cards, result.ops)
    const feelings = [...replayed.values()].filter((card) => card.kind === 'feeling')
    assert.equal(feelings.length, 1, '重放后感受卡必须存在')
    assert.equal(feelings[0]!.kind, 'feeling', 'kind 不得被降级')
  })

  it('distillEnabled 关闭时不产出感受', () => {
    const config = makeConfig({ consolidation: { distillEnabled: false } })
    const result = runConsolidation({ cards: repeatedStress() }, config, T0 + DAY_MS, TZ)
    assert.equal(result.cards.filter((card) => card.kind === 'feeling').length, 0)
    assert.equal(result.report.distilled, 0)
  })

  it('感受卡不被归档吃掉，即便阈值极高（FR-C3）', () => {
    const config = makeConfig({ forgetting: { archiveThreshold: 0.999 } })
    const result = runConsolidation({ cards: repeatedStress() }, config, T0 + 500 * DAY_MS, TZ)
    const feelings = result.cards.filter((card) => card.kind === 'feeling')
    assert.equal(feelings.length, 1)
    assert.equal(feelings[0]!.status, 'active', '感受卡必须存活（neverArchiveKinds）')
  })
})

describe('报告可读性（FR-F1 整理必须留痕）', () => {
  it('报告里能看到摘要与感受的数量', () => {
    const config = makeConfig()
    const cards = [
      ...dayCards(0, 6),
      makeCard({
        id: 'x1', kind: 'event', createdAt: T0 + 100, updatedAt: T0 + 100, emotional: 0.8,
        text: '评审会又崩了', entities: ['评审'],
      }),
      makeCard({
        id: 'x2', kind: 'event', createdAt: T0 + 200, updatedAt: T0 + 200, emotional: 0.8,
        text: '评审意见互相冲突', entities: ['评审'],
      }),
    ]
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    assert.ok(result.report.notes.some((note) => note.includes('摘要')), 'notes 应提到摘要')
    assert.ok(
      result.report.notes.some((note) => note.includes('感受')),
      'notes 应提到感受',
    )
    // 报告字段本身也要对得上。
    assert.equal(result.report.summarized, result.cards.filter((card) => card.kind === 'summary').length)
    assert.equal(result.report.distilled, result.cards.filter((card) => card.kind === 'feeling').length)
  })
})
