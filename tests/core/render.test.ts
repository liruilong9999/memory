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
import type { FocusPack, MemoryCard, ScoredCard } from '../../src/core/types.ts'

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
    note: cards.length === 0 ? '（本次没有相关记忆）' : '',
    query: '',
    builtAt: 0,
  }
}

describe('renderFocusPackExplain（FR-B4 可解释）', () => {
  it('空包给出明确说明而不是空串', () => {
    // 静默无输出会让人以为命令坏了（FR-B6 同一原则：宁可显式说明，不让人猜）。
    const text = renderFocusPackExplain(makePack([]), 0)
    assert.equal(text, '没有命中任何记忆（候选 0 张）')
  })

  it('空包也报出候选数：0 张候选与 12 张候选都无命中是两回事', () => {
    assert.equal(renderFocusPackExplain(makePack([]), 12), '没有命中任何记忆（候选 12 张）')
  })

  it('非空包首行报出包内张数与候选数', () => {
    const text = renderFocusPackExplain(makePack([makeScored('偏好 PostgreSQL', 0.539)]), 12)
    assert.ok(text.startsWith('焦点包 1 张，候选 12 张'))
  })

  it('每张卡有「■ 文本」+「总分 X」+ 缩进的 explain 各行', () => {
    const text = renderFocusPackExplain(makePack([makeScored('偏好 PostgreSQL', 0.539)]), 12)
    const lines = text.split('\n')
    assert.equal(lines[0], '焦点包 1 张，候选 12 张')
    assert.equal(lines[1], '')
    assert.equal(lines[2], '■ 偏好 PostgreSQL')
    assert.equal(lines[3], '  总分 0.539')
    assert.equal(lines[4], '  recency 0.5 × 0.25 = 0.125')
    assert.equal(lines[5], '  semantic 0.6 × 0.45 = 0.270')
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
    // 首行 + 空行 + 卡1(1+1+2行) + 空行 + 卡2(1+1+2行)
    assert.equal(lines.filter((line) => line === '').length, 2)
    assert.ok(lines.includes('■ 第一张'))
    assert.ok(lines.includes('■ 第二张'))
  })

  it('没有 explain 行时不产生多余空白行', () => {
    // explain 为空说明打分链路异常，但渲染不该因此吐出孤立的空行。
    const scored = makeScored('裸卡', 0.1, { explain: [] })
    const text = renderFocusPackExplain(makePack([scored]), 1)
    assert.equal(text, '焦点包 1 张，候选 1 张\n\n■ 裸卡\n  总分 0.100')
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
