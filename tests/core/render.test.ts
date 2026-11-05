/**
 * 共享人读渲染的单测（FR-B4）。
 *
 * 这个文件存在的核心目的不是「测格式」，而是**证明格式只有一份**：
 * 之前 `src/index.ts` 的 `/memory explain` 与 `src/cli/memoryctl.ts` 的
 * `query` 各自实现了一遍渲染，靠人肉同步维持一致。现在两边都调
 * `renderFocusPackExplain`，这个文件把输出格式钉死——任何人改格式都必须
 * 同时面对这些断言，不可能只改一处而让另一处悄悄漂移。
 *
 * @module tests/core/render.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { renderFocusPackExplain } from '../../src/core/render.ts'
import {
  EMPTY_PACK_NOTE, formatTime, lookupCard, renderEmptyNote, renderFocusPack,
} from '../../src/core/scoring.ts'
import type { FocusPack, MemoryCard, ScoredCard, TimeState } from '../../src/core/types.ts'

/**
 * 造一张最小可用的记忆卡。
 *
 * @param text - 卡片文本。
 * @returns 记忆卡。
 */
function makeCard(text: string): MemoryCard {
  return {
    id: 'card-' + text.length,
    domain: 'work',
    kind: 'fact',
    text,
    normalized: text.toLowerCase(),
    createdAt: 0,
    updatedAt: 0,
    source: { sessionId: 's', turn: 1, step: 0, seq: 1, eventType: 'user/message' },
    tags: [],
    entities: [],
    salience: 0.5,
    confidence: 0.8,
    emotional: 0,
    strength: 1,
    accessCount: 0,
    lastAccessAt: null,
    pinned: false,
    status: 'active',
    revisions: [],
    conflictOf: [],
    dueAt: null,
  }
}

/**
 * 造一张已打分的卡片。
 *
 * @param text - 卡片文本。
 * @param total - 总分。
 * @param extra - 额外的打分字段。
 * @returns 已打分卡片。
 */
function makeScored(
  text: string, total: number, extra: Partial<ScoredCard> = {},
): ScoredCard {
  // `relevance` 不是随手编的数：它必须与下面的 `semantic` / `goal` 自洽，
  // 否则 fixture 会成为一个**假的真相源**——将来若有人给渲染加一行
  // 「相关分量」，他会看到 0.6 的语义配一个不匹配的 relevance，
  // 然后开始怀疑是渲染算错了。按 `scoreCard` 的公式反推：
  //   (0.6×0.42 + 0×0.10) / (0.42 + 0.10) = 0.4846
  // 权重取自 `DEFAULT_CONFIG.weights`。
  return {
    card: makeCard(text),
    score: {
      total,
      recency: 0.5,
      semantic: 0.6,
      goal: 0,
      importance: 0.7,
      confidence: 0.8,
      conflictPenalty: 0,
      relevance: 0.6 * 0.42 / 0.52,
    },
    explain: ['recency 0.5 × 0.25 = 0.125', 'semantic 0.6 × 0.45 = 0.270'],
    conflict: false,
    ...extra,
  }
}

/**
 * 造一个焦点包。
 *
 * @param cards - 包内卡片。
 * @returns 焦点包。
 */
function makePack(cards: ScoredCard[]): FocusPack {
  return {
    cards,
    tokens: 100,
    budgetTokens: 1200,
    maxCardChars: 200,
    empty: cards.length === 0,
    // 用生产常量而不是手写第三份文案。此前这里是 `'（本次没有相关记忆）'`
    // ——fixture 自己编了一句，于是「渲染层的空包文案」和「pack.note」永远是
    // 两个值，而这条 fixture 恰好让「两者同源」这个性质**无法被测出来**。
    // **fixture 里的字面量也是真相源，它一样会腐烂。**
    note: cards.length === 0 ? EMPTY_PACK_NOTE : '',
    query: '',
    builtAt: 0,
  }
}

describe('renderFocusPackExplain（FR-B4 可解释）', () => {
  it('空包给出明确说明而不是空串', () => {
    // 静默无输出会让人以为命令坏了（FR-B6 同一原则：宁可显式说明，不让人猜）。
    const text = renderFocusPackExplain(makePack([]), 0)
    assert.equal(text, '没有相关记忆。（候选 0 张）')
  })

  it('空包文案与 renderEmptyNote 同源，不是抄的第二份', () => {
    // 这条守的是 FR-B6 / ST-5 的**可检索性**：ST-5 验收原话是
    // 「明确回答"没有相关记忆"」，而人读渲染此前写的是「没有命中任何记忆」
    // ——两句话都在说同一件事，但在终端里 grep ST-5 那句是搜不到的。
    //
    // 断言用 `renderEmptyNote` 的输出做**前缀**，而不是再写一遍字面量：
    // 字面量会变成第三份真相源，改文案时这里会跟着红、但红的原因不对。
    const pack = makePack([])
    const note = renderEmptyNote(pack)
    assert.equal(note, '没有相关记忆。')
    assert.ok(
      renderFocusPackExplain(pack, 3).startsWith(note),
      '空包渲染必须以 renderEmptyNote 的文案开头',
    )
  })

  it('空包也报出候选数：0 张候选与 12 张候选都无命中是两回事', () => {
    assert.equal(renderFocusPackExplain(makePack([]), 12), '没有相关记忆。（候选 12 张）')
  })

  it('非空包首行报出包内张数与候选数', () => {
    const text = renderFocusPackExplain(makePack([makeScored('偏好 PostgreSQL', 0.539)]), 12)
    assert.ok(text.startsWith('焦点包 1 张，候选 12 张'))
  })

  it('每张卡有「■ 文本」+「卡片 id」+「总分 X」+ 缩进的 explain 各行', () => {
    const text = renderFocusPackExplain(makePack([makeScored('偏好 PostgreSQL', 0.539)]), 12)
    const lines = text.split('\n')
    assert.equal(lines[0], '焦点包 1 张，候选 12 张')
    assert.equal(lines[1], '')
    assert.equal(lines[2], '■ 偏好 PostgreSQL')
    assert.equal(lines[3], '  卡片 id card-13')
    assert.equal(lines[4], '  总分 0.539')
    assert.equal(lines[5], '  recency 0.5 × 0.25 = 0.125')
    assert.equal(lines[6], '  semantic 0.6 × 0.45 = 0.270')
  })

  it('每张卡都印出可以粘给 restore / revise 的 id（FR-A5 / FR-C2 的前置条件）', () => {
    // 这条守的不是「有个 id 字样」，而是**输出与输入的闭环**：
    // 渲染出来的字符串必须能被 formatCardRef 的逆运算（lookupCard）解析回同一张卡。
    // 只断言 `includes('卡片 id')` 的话，印成 `卡片 id ？？？` 也一样绿。
    const scored = makeScored('偏好 PostgreSQL', 0.539)
    const text = renderFocusPackExplain(makePack([scored]), 1)
    const idLine = text.split('\n').find((line) => line.startsWith('  卡片 id '))
    assert.ok(idLine !== undefined, `前提：必须有一行卡片 id，实际输出：\n${text}`)
    const printed = idLine.slice('  卡片 id '.length)
    assert.equal(printed, scored.card.id, '前提：这张卡的 id 不足 8 位，应原样印出')
    const resolved = lookupCard([scored.card], printed)
    assert.equal(resolved.ok, true, `印出来的 id 必须能被解析：${printed}`)
    if (resolved.ok) assert.equal(resolved.card.id, scored.card.id)
  })

  it('总分保留三位小数', () => {
    // 三位是刻意选的：召回分数常落在 0.5~0.6 区间，两位看不出区分度，
    // 四位会让人误以为有那个精度。
    const text = renderFocusPackExplain(makePack([makeScored('x', 0.5)]), 1)
    assert.ok(text.includes('总分 0.500'), text)
    const text2 = renderFocusPackExplain(makePack([makeScored('x', 0.123456)]), 1)
    assert.ok(text2.includes('总分 0.123'), text2)
  })

  it('有冲突的卡标出「（有冲突）」', () => {
    const scored = makeScored('偏好 MySQL', 0.4, { conflict: true })
    const text = renderFocusPackExplain(makePack([scored]), 2)
    assert.ok(text.includes('总分 0.400（有冲突）'), text)
  })

  it('多张卡之间用空行分隔，不粘连', () => {
    const text = renderFocusPackExplain(
      makePack([makeScored('第一张', 0.5), makeScored('第二张', 0.4)]), 5,
    )
    const lines = text.split('\n')
    // 首行 + 空行 + 卡1(1+1+1+2行) + 空行 + 卡2(1+1+1+2行)
    assert.equal(lines.filter((line) => line === '').length, 2)
    assert.ok(lines.includes('■ 第一张'))
    assert.ok(lines.includes('■ 第二张'))
    // id 行也跟着空行分组，不会两张卡共用一个 id 行。
    assert.equal(lines.filter((line) => line.startsWith('  卡片 id ')).length, 2)
  })

  it('没有 explain 行时不产生多余空白行', () => {
    // explain 为空说明打分链路异常，但渲染不该因此吐出孤立的空行。
    const scored = makeScored('裸卡', 0.1, { explain: [] })
    const text = renderFocusPackExplain(makePack([scored]), 1)
    assert.equal(text, '焦点包 1 张，候选 1 张\n\n■ 裸卡\n  卡片 id card-2\n  总分 0.100')
  })

  it('同一输入渲染两次结果完全一致（ST-1 确定性）', () => {
    const pack = makePack([makeScored('a', 0.5), makeScored('b', 0.4)])
    assert.equal(renderFocusPackExplain(pack, 7), renderFocusPackExplain(pack, 7))
  })
})

/**
 * 影子模式观察值的渲染（FR-G1 / 起源 L15·无编号·图谱）。
 *
 * 影子模式的价值全在「人能看到它想做什么」——算完不显示等于没算。
 * 但显示必须**明确标注未生效**：观察值长得像分数的一部分，读者很容易
 * 以为它已经参与了排序，从而对召回结果产生错误预期。
 *
 * 这里同时守住两条边界：
 * 1. 观察值**不混进 `explain`**——`explain` 的语义是「这个分数怎么算出来的」，
 *    而影子值没参与计算，混进去就是让解释替实现撒谎。
 * 2. 注入文本（`renderFocusPack`）**完全不读它**，所以不可能污染上下文
 *    （起源 L17·无编号·上下文污染）。
 */
describe('renderFocusPackExplain 的影子模式观察值', () => {
  it('有观察值时渲染出加分量与排名变化，并标注未生效', () => {
    const scored = makeScored('被扩散提权的卡', 0.45, {
      shadowSpread: {
        boost: 0.099,
        sources: ['seed-a', 'seed-b'],
        hypotheticalTotal: 0.549,
        hypotheticalRank: 1,
        actualRank: 2,
      },
    })
    const text = renderFocusPackExplain(makePack([scored]), 2)
    assert.ok(text.includes('[影子]'), '必须显式标出这是影子值')
    assert.ok(text.includes('+0.099'), '必须显示加了多少分')
    assert.ok(text.includes('0.549'), '必须显示假设总分')
    assert.ok(text.includes('2 → 1'), '必须显示排名变化')
    assert.ok(text.includes('未生效'), '必须明说当前未生效——这是最容易被误读的一点')
    assert.ok(text.includes('2 张种子卡'), '必须显示激活来自几张种子卡')
  })

  it('没有观察值时不产生任何影子行（off / on 模式）', () => {
    const scored = makeScored('普通卡', 0.5)
    const text = renderFocusPackExplain(makePack([scored]), 1)
    assert.ok(!text.includes('[影子]'), '没有观察值时不得凭空渲染影子行')
  })

  it('观察值不混进 explain（解释不能替实现撒谎）', () => {
    // explain 的语义是「这个分数怎么算出来的」。影子值没参与计算，
    // 若混进 explain，读者会以为总分里已经含了那 0.099。
    const explainLines = ['recency 0.5 × 0.25 = 0.125']
    const scored = makeScored('卡', 0.45, {
      explain: explainLines,
      shadowSpread: {
        boost: 0.099, sources: ['s'], hypotheticalTotal: 0.549,
        hypotheticalRank: 1, actualRank: 2,
      },
    })
    renderFocusPackExplain(makePack([scored]), 1)
    assert.deepEqual(scored.explain, explainLines, '渲染不得修改 explain 数组')
    assert.equal(scored.explain.length, 1, '渲染不得往 explain 里追加行')
  })

  it('总分仍显示实际值，不显示假设值', () => {
    const scored = makeScored('卡', 0.45, {
      shadowSpread: {
        boost: 0.099, sources: ['s'], hypotheticalTotal: 0.549,
        hypotheticalRank: 1, actualRank: 2,
      },
    })
    const text = renderFocusPackExplain(makePack([scored]), 1)
    assert.ok(text.includes('总分 0.450'), '总分必须是实际值 0.450')
    assert.ok(!text.includes('总分 0.549'), '假设值绝不能出现在「总分」那一行')
  })

  it('渲染两次结果一致（ST-1 确定性）', () => {
    const scored = makeScored('卡', 0.45, {
      shadowSpread: {
        boost: 0.1, sources: ['s'], hypotheticalTotal: 0.55,
        hypotheticalRank: 1, actualRank: 2,
      },
    })
    const pack = makePack([scored])
    assert.equal(renderFocusPackExplain(pack, 1), renderFocusPackExplain(pack, 1))
  })
})

/**
 * FR-D1：注入文本必须带上**当前绝对时刻**。
 *
 * 这条需求此前**零断言**——`renderFocusPack` 一直产出 `当前时间：...` 这一行，
 * 但没有任何测试读它。`tests/core/scoring.test.ts` 那条截断用例只截
 * `- [` 开头的行，恰好绕过了它。**「代码里有」和「有人守」是两件事**，
 * 前者不能替代后者：这一行哪天被顺手删掉，全部测试依然绿。
 *
 * 为什么它重要：模型没有时钟。不给绝对时刻，它就无法判断「这条记忆是三年前的
 * 还是昨天的」，只能靠猜——而猜年份是模型最容易编造的地方（起源 L19
 * 「感受与经验」，L5「连续人生」都依赖时间锚点）。
 *
 * @module tests/core/render.test
 */
describe('renderFocusPack 的绝对时刻（FR-D1）', () => {
  /** 造一个只有一张卡的非空焦点包。 */
  function packWithOneCard(): FocusPack {
    return makePack([makeScored('这个项目用 Qt5 开发', 0.6)])
  }

  it('注入文本包含「当前时间：YYYY-MM-DD HH:mm」且时区正确', () => {
    const time: TimeState = {
      now: 1_700_000_000_000, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
      sinceLastSession: null, sinceLastTurn: null, sessionStartedAt: null, due: [],
    }
    const rendered = renderFocusPack(packWithOneCard(), time)
    const line = rendered.split('\n').find((l) => l.startsWith('当前时间：'))
    assert.ok(line !== undefined, `注入文本必须有当前时间行，实际：\n${rendered}`)
    // 断言具体值而不是「匹配 \d{4}」：正则只证明「有个像时间的东西」，
    // 时区写错、格式漂移都能通过。这里把 UTC 与上海两个值都算出来对比，
    // 才能证明**时区真的被用上了**（UTC 是 2023-11-14 22:13，上海是次日 06:13）。
    assert.equal(line, '当前时间：2023-11-15 06:13')
    assert.equal(formatTime(time.now, 'UTC'), '2023-11-14 22:13', '前提：两个时区在这一刻必须跨日，否则时区断言测不出东西')
    assert.notEqual(formatTime(time.now, 'Asia/Shanghai'), formatTime(time.now, 'UTC'))
  })

  it('时间随注入时钟变化（不是写死的常量）', () => {
    const base: TimeState = {
      now: 1_700_000_000_000, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
      sinceLastSession: null, sinceLastTurn: null, sessionStartedAt: null, due: [],
    }
    const oneHourLater: TimeState = { ...base, now: base.now + 60 * 60 * 1000 }
    const a = renderFocusPack(packWithOneCard(), base)
    const b = renderFocusPack(packWithOneCard(), oneHourLater)
    const lineOf = (text: string): string => text.split('\n').find((l) => l.startsWith('当前时间：')) ?? ''
    assert.notEqual(lineOf(a), lineOf(b), '一小时之后注入的时间行必须不同，否则它是写死的')
    assert.equal(lineOf(b), '当前时间：2023-11-15 07:13')
  })

  it('时间行只出现一次（重复注入会让模型以为有两套时钟）', () => {
    const time: TimeState = {
      now: 1_700_000_000_000, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
      sinceLastSession: null, sinceLastTurn: null, sessionStartedAt: null, due: [],
    }
    const rendered = renderFocusPack(packWithOneCard(), time)
    const count = rendered.split('\n').filter((l) => l.startsWith('当前时间：')).length
    assert.equal(count, 1, `当前时间行必须恰好一行，实际 ${count} 行`)
  })

  it('空包时不产出时间行（空包整体不注入）', () => {
    // 与「空包返回空串」配对：若哪天改成空包也注入时间，模型会收到一段
    // 只有时间、没有记忆的上下文，等于告诉它「有记忆但我没给你」。
    const time: TimeState = {
      now: 1_700_000_000_000, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
      sinceLastSession: null, sinceLastTurn: null, sessionStartedAt: null, due: [],
    }
    assert.equal(renderFocusPack(makePack([]), time), '')
  })
})
