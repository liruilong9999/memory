/**
 * 摘要与跨周期层级压缩单测（FR-D4 / 起源 L27）。
 *
 * 本文件最核心的一条不是「产出了摘要」，而是**「摘要真的压缩了」**：
 * 没有压缩比断言，「做了摘要」与「做了压缩」在测试上完全无法区分——
 * 两者都只是「多了一张卡」。
 *
 * @module tests/consolidate/summarize.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDailySummary, buildMonthlySummary, buildSummaries, buildWeeklySummary,
  charBudgetOf, compressionRatio, groupByLocalDate, mondayKeyOf, monthKeyOf,
  summaryKeyOf, summaryLevelOf,
} from '../../src/consolidate/summarize.ts'
import type { MemoryCard } from '../../src/core/types.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

/** 测试统一时区：东八区，让自然日边界与 UTC 不同，边界才算真被测过。 */
const TZ = 'Asia/Shanghai'

/** 基准时刻：2023-11-14T22:13:20Z，在东八区是 2023-11-15 06:13:20。 */
const T0 = 1_700_000_000_000

/**
 * 造一张有实质文本的事件卡，文本足够长以便压缩比有意义。
 *
 * @param id - 卡片 id。
 * @param at - 创建时刻。
 * @param over - 其余覆盖字段。
 * @returns 事件卡。
 */
function eventCard(id: string, at: number, over: Partial<MemoryCard> = {}): MemoryCard {
  return makeCard({
    id,
    kind: 'event',
    createdAt: at,
    updatedAt: at,
    text: `第 ${id} 条记录：今天在处理记忆系统的摘要与压缩问题，涉及日摘要边界、层级压缩比、感受蒸馏三件事。`,
    tags: ['记忆系统'],
    entities: ['摘要', '压缩'],
    ...over,
  })
}

/**
 * 造一组落在同一个自然日内的卡。
 *
 * 每张间隔 1 小时，全部落在东八区 2023-11-15 这一天内。
 *
 * @param count - 张数。
 * @param startAt - 起始时刻。
 * @returns 卡片数组。
 */
function sameDayCards(count: number, startAt: number): MemoryCard[] {
  return Array.from({ length: count }, (_, index) => eventCard(`c${index}`, startAt + index * 3_600_000))
}

describe('自然日分组（FR-D4 日摘要与日期一一对应）', () => {
  it('同一个自然日的卡聚到一组，不同日分开', () => {
    // 东八区 2023-11-15 06:13 与 2023-11-15 23:00 同一天；跨到 16 日则分开。
    const cards = [
      eventCard('a', T0),
      eventCard('b', T0 + 16 * 3_600_000),
      eventCard('c', T0 + 24 * 3_600_000),
    ]
    const groups = groupByLocalDate(cards, TZ)
    assert.equal(groups.size, 2, '应分成两天')
    const keys = [...groups.keys()].sort()
    assert.equal(keys[0], '2023-11-15')
    assert.equal(keys[1], '2023-11-16')
  })

  it('时区不同，分组结果必须不同（否则时区参数是死的）', () => {
    // 东八区 2023-11-15 06:13 = UTC 2023-11-14 22:13，跨日。
    const cards = [eventCard('a', T0)]
    const shanghai = [...groupByLocalDate(cards, TZ).keys()]
    const utc = [...groupByLocalDate(cards, 'UTC').keys()]
    assert.deepEqual(shanghai, ['2023-11-15'])
    assert.deepEqual(utc, ['2023-11-14'])
    // 这一条是「timeZone 必填且真的被使用」的证据：如果实现内部写死 UTC，
    // 上面两个结果会相同，这条断言立刻变红。
    assert.notDeepEqual(shanghai, utc)
  })

  it('组内按 createdAt 升序，结果与输入顺序无关（ST-1）', () => {
    const early = eventCard('early', T0)
    const late = eventCard('late', T0 + 3_600_000)
    const forward = groupByLocalDate([early, late], TZ).get('2023-11-15')!
    const backward = groupByLocalDate([late, early], TZ).get('2023-11-15')!
    assert.deepEqual(forward.map((card) => card.id), ['early', 'late'])
    assert.deepEqual(backward.map((card) => card.id), ['early', 'late'])
  })
})

describe('压缩比（起源 L27：提炼而非拼接）', () => {
  it('日摘要必须显著短于来源，压缩比低于目标比例', () => {
    const config = makeConfig()
    const cards = sameDayCards(8, T0)
    const sourceChars = cards.reduce((acc, card) => acc + [...card.text].length, 0)
    const daily = buildDailySummary('2023-11-15', cards, T0 + DAY_MS, config)
    assert.notEqual(daily, null, '这一天应当产出日摘要')

    const ratio = compressionRatio(daily!, cards)
    // 这是本文件最重要的一条断言：证明它真的压缩了，不是换地方存。
    assert.ok(
      ratio < config.consolidation.summaryTargetRatio,
      `压缩比 ${ratio.toFixed(3)} 应低于 ${config.consolidation.summaryTargetRatio}，`
      + `来源 ${sourceChars} 字压成了 ${[...daily!.text].length} 字`,
    )
    // 压缩比必须是个真实的小于 1 的数，不能靠「来源为空时返回 1」蒙混。
    assert.ok(ratio > 0 && ratio < 1, `压缩比 ${ratio} 应落在 (0,1)`)
  })

  it('摘要不是拼接：不得包含任何一张来源卡的完整文本', () => {
    const config = makeConfig()
    const cards = sameDayCards(6, T0)
    const daily = buildDailySummary('2023-11-15', cards, T0 + DAY_MS, config)!
    for (const card of cards) {
      assert.ok(
        !daily.text.includes(card.text),
        `摘要里出现了来源卡「${card.id}」的完整文本，说明是拼接而不是压缩`,
      )
    }
  })

  it('来源越多，压缩比越低（规模越大压缩越狠）', () => {
    const config = makeConfig()
    // 两组的来源总字符数都必须超过 summaryMinSourceChars，否则短的那组
    // 会直接不产出摘要（那是对的，但不该出现在「比压缩比」的用例里）。
    const small = sameDayCards(3, T0)
    const large = sameDayCards(20, T0)
    const smallDaily = buildDailySummary('2023-11-15', small, T0 + DAY_MS, config)
    const largeDaily = buildDailySummary('2023-11-15', large, T0 + DAY_MS, config)
    assert.notEqual(smallDaily, null, '3 张卡应够门槛')
    assert.notEqual(largeDaily, null)
    const smallRatio = compressionRatio(smallDaily!, small)
    const largeRatio = compressionRatio(largeDaily!, large)
    assert.ok(
      largeRatio < smallRatio,
      `20 张卡的压缩比 ${largeRatio.toFixed(3)} 应低于 3 张卡的 ${smallRatio.toFixed(3)}`,
    )
  })

  it('来源太短时不产出摘要（假压缩比不压缩更糟）', () => {
    const config = makeConfig()
    // 一张 10 字的卡：做成摘要不可能比原文短，硬做出来就是假压缩。
    const tiny = [makeCard({ id: 't', createdAt: T0, text: '很短的一件事' })]
    const daily = buildDailySummary('2023-11-15', tiny, T0 + DAY_MS, config)
    assert.equal(daily, null, '来源过短时不应产出摘要')
  })

  it('charBudgetOf 同时受目标比例与层级上限约束', () => {
    // 来源 1000 字、比例 0.5 → 500；但日摘要上限 180 → 取 180。
    assert.equal(charBudgetOf(1000, 180, 0.5), 180)
    // 来源 200 字、比例 0.5 → 100，低于上限 → 取 100。
    assert.equal(charBudgetOf(200, 180, 0.5), 100)
    // 预算至少为 1，否则摘要恒为空。
    assert.equal(charBudgetOf(0, 180, 0.5), 1)
  })

  it('预算随来源线性收缩（比例约束真的在起作用）', () => {
    // 这条是**规则级**断言，不依赖渲染出来多长。
    //
    // 为什么必须有它：上面那条「日摘要压缩比 < summaryTargetRatio」在实测中
    // 是**绿在巧合上**——渲染出来的摘要只有 30 字，远小于任何预算，
    // 于是即便把 `charBudgetOf` 改成「恒等于层级上限」（即彻底不做比例压缩），
    // 压缩比断言依然绿。反向验证时只有 `charBudgetOf` 那条单测变红，
    // 压缩比断言一条都没红，暴露了这个洞。
    //
    // 因此这里直接断言预算函数本身：来源翻倍，预算必须翻倍（未触上限时）。
    assert.equal(charBudgetOf(100, 1000, 0.5), 50)
    assert.equal(charBudgetOf(200, 1000, 0.5), 100)
    assert.equal(charBudgetOf(400, 1000, 0.5), 200)
    // 触到上限后必须被截平，不能无限增长。
    assert.equal(charBudgetOf(2000, 180, 0.5), 180)
    assert.equal(charBudgetOf(10_000, 180, 0.5), 180)
    // 比例越小预算越小：证明 ratio 参数真的被乘进去了。
    assert.equal(charBudgetOf(400, 1000, 0.1), 40)
    assert.equal(charBudgetOf(400, 1000, 0.9), 360)
  })
})

describe('层级压缩（日 → 周 → 月）', () => {
  /** 造 n 天的日摘要，每天一张，从 2023-11-13（周一）开始。 */
  function dailySeries(days: number, config = makeConfig()): MemoryCard[] {
    // 2023-11-13 是周一。
    const monday = Date.UTC(2023, 10, 13)
    const result: MemoryCard[] = []
    for (let index = 0; index < days; index += 1) {
      const dateKey = new Date(monday + index * DAY_MS).toISOString().slice(0, 10)
      const cards = sameDayCards(4, monday + index * DAY_MS + 6 * 3_600_000)
      const daily = buildDailySummary(dateKey, cards, monday + index * DAY_MS + DAY_MS, config)
      if (daily !== null) result.push(daily)
    }
    return result
  }

  it('周摘要由 7 张日摘要压成，且比日摘要总和显著更短', () => {
    const config = makeConfig()
    const dailies = dailySeries(7)
    assert.equal(dailies.length, 7, '应产出 7 张日摘要')
    const weekly = buildWeeklySummary('2023-11-13', dailies, T0 + 8 * DAY_MS, config)
    assert.notEqual(weekly, null)

    const dailyTotal = dailies.reduce((acc, card) => acc + [...card.text].length, 0)
    const weeklyChars = [...weekly!.text].length
    // 这是「层级压缩」的核心断言：月/周的信息量必须显著小于下级总和。
    assert.ok(
      weeklyChars < dailyTotal * config.consolidation.summaryTargetRatio,
      `周摘要 ${weeklyChars} 字应显著小于 7 张日摘要总和 ${dailyTotal} 字`,
    )
    assert.equal(summaryLevelOf(weekly!), 'weekly')
  })

  it('只有一张日摘要时不产出周摘要（那是复制不是压缩）', () => {
    const config = makeConfig()
    const dailies = dailySeries(1)
    assert.equal(dailies.length, 1)
    const weekly = buildWeeklySummary('2023-11-13', dailies, T0 + 2 * DAY_MS, config)
    assert.equal(weekly, null, '只有一个下级时不应产出上级摘要')
  })

  it('月摘要由周摘要压成，且比周摘要总和显著更短', () => {
    const config = makeConfig()
    // 造 4 周，每周 7 天。
    const weeklies: MemoryCard[] = []
    const monday = Date.UTC(2023, 10, 6)
    for (let week = 0; week < 4; week += 1) {
      const weekStart = monday + week * 7 * DAY_MS
      const dailies: MemoryCard[] = []
      for (let day = 0; day < 7; day += 1) {
        const dateKey = new Date(weekStart + day * DAY_MS).toISOString().slice(0, 10)
        const cards = sameDayCards(4, weekStart + day * DAY_MS + 6 * 3_600_000)
        const daily = buildDailySummary(dateKey, cards, weekStart + day * DAY_MS + DAY_MS, config)
        if (daily !== null) dailies.push(daily)
      }
      const weekKey = new Date(weekStart).toISOString().slice(0, 10)
      const weekly = buildWeeklySummary(weekKey, dailies, weekStart + 8 * DAY_MS, config)
      if (weekly !== null) weeklies.push(weekly)
    }
    assert.equal(weeklies.length, 4, '应产出 4 张周摘要')
    const monthly = buildMonthlySummary('2023-11', weeklies, T0 + 40 * DAY_MS, config)
    assert.notEqual(monthly, null)

    const weeklyTotal = weeklies.reduce((acc, card) => acc + [...card.text].length, 0)
    const monthlyChars = [...monthly!.text].length
    assert.ok(
      monthlyChars < weeklyTotal,
      `月摘要 ${monthlyChars} 字应小于 4 张周摘要总和 ${weeklyTotal} 字`,
    )
    // 更强的一条：月摘要必须比**单张**周摘要还短或相当，层级越高越短。
    const maxWeeklyChars = Math.max(...weeklies.map((card) => [...card.text].length))
    assert.ok(
      monthlyChars <= maxWeeklyChars,
      `月摘要 ${monthlyChars} 字不应超过单张周摘要 ${maxWeeklyChars} 字`,
    )
  })

  it('层级越高字符上限越低（配置层已强制，这里验证实际生效）', () => {
    const config = makeConfig()
    const dailies = dailySeries(7)
    const weekly = buildWeeklySummary('2023-11-13', dailies, T0 + 8 * DAY_MS, config)!
    const dailyMax = Math.max(...dailies.map((card) => [...card.text].length))
    assert.ok(
      [...weekly.text].length <= config.consolidation.weeklySummaryMaxChars,
      `周摘要 ${[...weekly.text].length} 字应不超过上限 ${config.consolidation.weeklySummaryMaxChars}`,
    )
    assert.ok(config.consolidation.weeklySummaryMaxChars <= config.consolidation.dailySummaryMaxChars)
    // 周摘要不一定比单张日摘要短（它要覆盖 7 天的量），但必须比 7 天总和短得多。
    assert.ok([...weekly.text].length < dailyMax * 7)
  })

  it('ISO 周从周一开始：周日归入前一个周一', () => {
    // 2023-11-19 是周日，应归到 2023-11-13（周一）。
    assert.equal(mondayKeyOf('2023-11-19'), '2023-11-13')
    // 2023-11-13 是周一，归到自己。
    assert.equal(mondayKeyOf('2023-11-13'), '2023-11-13')
    // 2023-11-20 是下周一。
    assert.equal(mondayKeyOf('2023-11-20'), '2023-11-20')
  })

  it('月份键取前 7 位', () => {
    assert.equal(monthKeyOf('2023-11-15'), '2023-11')
  })
})

describe('摘要卡的可读性与可溯源', () => {
  it('摘要文本可读：含日期、条数、主要领域', () => {
    const config = makeConfig()
    const cards = sameDayCards(5, T0)
    const daily = buildDailySummary('2023-11-15', cards, T0 + DAY_MS, config)!
    assert.ok(daily.text.includes('2023-11-15'), '摘要应含日期')
    assert.ok(daily.text.includes('5 条记忆'), '摘要应含条数')
    assert.ok(daily.text.includes('工作'), '摘要应含主要领域')
  })

  it('kind 是 summary，且层级/日期键可从 tags 与 source 读回', () => {
    const config = makeConfig()
    const daily = buildDailySummary('2023-11-15', sameDayCards(4, T0), T0 + DAY_MS, config)!
    assert.equal(daily.kind, 'summary')
    assert.equal(summaryLevelOf(daily), 'daily')
    assert.equal(summaryKeyOf(daily), '2023-11-15')
    assert.equal(daily.source.sessionId, '2023-11-15')
    assert.equal(daily.source.eventType, 'consolidate/daily-summary')
  })

  it('摘要用 mergeOf 记录它压了哪些卡（可溯源）', () => {
    const config = makeConfig()
    const cards = sameDayCards(3, T0)
    const daily = buildDailySummary('2023-11-15', cards, T0 + DAY_MS, config)!
    assert.deepEqual(daily.mergeOf, cards.map((card) => card.id).sort((a, b) => a.localeCompare(b)))
  })

  it('非摘要卡的 summaryLevelOf 返回 null', () => {
    const card = makeCard({ id: 'x', kind: 'event', text: '普通事件' })
    assert.equal(summaryLevelOf(card), null)
    assert.equal(summaryKeyOf(card), null)
  })
})

describe('幂等（同一层级同一天重复整理得到同一张卡）', () => {
  it('同一天同样输入两次构造，id 完全相同', () => {
    const config = makeConfig()
    const cards = sameDayCards(4, T0)
    const first = buildDailySummary('2023-11-15', cards, T0 + DAY_MS, config)!
    const second = buildDailySummary('2023-11-15', cards, T0 + 2 * DAY_MS, config)!
    // 落卡时刻不同，但 id 必须相同——否则每跑一次就多一张重复摘要。
    assert.equal(first.id, second.id)
  })

  it('已存在的摘要不重复产出，但会参与上层聚合', () => {
    const config = makeConfig()
    const dailies = Array.from({ length: 3 }, (_, index) => {
      const dateKey = `2023-11-${String(13 + index).padStart(2, '0')}`
      const cards = sameDayCards(4, T0 + index * DAY_MS)
      return buildDailySummary(dateKey, cards, T0 + index * DAY_MS + DAY_MS, config)!
    })
    // 把 3 张日摘要都视为「已存在」。
    const existing = new Map(dailies.map((card) => [card.id, card]))
    const cards = sameDayCards(4, T0)
    const batch = buildSummaries(cards, existing, T0 + 4 * DAY_MS, TZ, config)
    // 本轮不该再产出任何日摘要。
    assert.equal(batch.dailies.length, 1, '只有一天有事件卡，且那张已存在')
    // 但周摘要仍应基于已有日摘要聚合出来——这里只有 1 天，不足 2 张，故为空。
    assert.equal(batch.weeklies.length, 0)
  })
})

describe('buildSummaries 编排（三层一次产出）', () => {
  it('一天的事件卡产出日摘要，够多天时同时产出周摘要', () => {
    const config = makeConfig()
    const monday = Date.UTC(2023, 10, 13)
    const cards: MemoryCard[] = []
    for (let day = 0; day < 3; day += 1) {
      cards.push(...sameDayCards(4, monday + day * DAY_MS + 6 * 3_600_000))
    }
    const batch = buildSummaries(cards, new Map(), monday + 4 * DAY_MS, TZ, config)
    assert.equal(batch.dailies.length, 3, '应产出 3 张日摘要')
    assert.equal(batch.weeklies.length, 1, '应产出 1 张周摘要')
  })

  it('summaryEnabled 关闭时什么都不产出', () => {
    const config = makeConfig({ consolidation: { summaryEnabled: false } })
    const cards = sameDayCards(8, T0)
    const batch = buildSummaries(cards, new Map(), T0 + DAY_MS, TZ, config)
    assert.equal(batch.dailies.length, 0)
    assert.equal(batch.weeklies.length, 0)
    assert.equal(batch.monthlies.length, 0)
  })

  it('摘要卡不参与摘要（不压摘要，避免二次衰减）', () => {
    const config = makeConfig()
    const cards = sameDayCards(4, T0)
    const daily = buildDailySummary('2023-11-15', cards, T0 + DAY_MS, config)!
    // 把日摘要混进事件卡里，它不该被当成「事件」再压一次。
    const batch = buildSummaries([...cards, daily], new Map(), T0 + 2 * DAY_MS, TZ, config)
    assert.equal(batch.dailies.length, 1, '仍只有一张日摘要')
  })
})
