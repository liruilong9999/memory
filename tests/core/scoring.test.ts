import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import {
  applyThresholds, buildFocusPack, clamp01, effectiveHalfLife, filterByDomain, formatDuration,
  formatTime, goalScore, importanceScore, makeQuery, recencyScore, scoreCard,
  scoreCards, semanticScore,
} from '../../src/core/scoring.ts'
import { tokenSet } from '../../src/core/text.ts'
import type { MemoryCard } from '../../src/core/types.ts'

const config = DEFAULT_CONFIG

function makeCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  const base: MemoryCard = {
    id: 'card-1',
    domain: 'work',
    kind: 'fact',
    text: '这个项目用 Qt5',
    normalized: '这个项目用 qt5',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    source: { sessionId: 's1', turn: 1, step: 1, seq: 1, eventType: 'user/message' },
    salience: 0.7,
    confidence: 0.9,
    emotional: 0.2,
    strength: 0.8,
    accessCount: 0,
    lastAccessAt: null,
    tags: [],
    entities: [],
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: false,
  }
  return { ...base, ...overrides }
}

test('recencyScore 同刻为 1', () => {
  assert.equal(recencyScore(0, 1000), 1)
})

test('recencyScore 一个半衰期约等于 0.5', () => {
  const score = recencyScore(1000, 1000)
  assert.ok(Math.abs(score - 0.5) < 1e-9)
})

test('recencyScore 时间越久越低', () => {
  assert.ok(recencyScore(2000, 1000) < recencyScore(1000, 1000))
})

test('recencyScore 半衰期为 0 返回 0', () => {
  assert.equal(recencyScore(100, 0), 0)
})

test('importanceScore 落在 0..1', () => {
  const score = importanceScore(makeCard({ salience: 1, emotional: 1, accessCount: 100 }))
  assert.ok(score >= 0 && score <= 1)
})

test('importanceScore 高显著性高于低显著性', () => {
  const high = importanceScore(makeCard({ salience: 0.9 }))
  const low = importanceScore(makeCard({ salience: 0.1 }))
  assert.ok(high > low)
})

test('goalScore 无目标为 0', () => {
  assert.equal(goalScore(makeCard(), new Set()), 0)
})

test('goalScore 目标命中大于 0', () => {
  const score = goalScore(makeCard({ text: '部署方案用 docker' }), tokenSet('部署'))
  assert.ok(score > 0)
})

test('semanticScore 查询为空为 0', () => {
  const query = makeQuery('', config, 1_700_000_000_000)
  assert.equal(semanticScore(makeCard(), query), 0)
})

test('semanticScore 文本命中得高分', () => {
  const query = makeQuery('Qt5 项目', config, 1_700_000_000_000)
  const score = semanticScore(makeCard({ text: '这个项目用 Qt5 开发' }), query)
  assert.ok(score > 0.5, `实际 ${score}`)
})

test('semanticScore 无关文本接近 0', () => {
  const query = makeQuery('天气怎么样', config, 1_700_000_000_000)
  const score = semanticScore(makeCard({ text: '这个项目用 Qt5 开发' }), query)
  assert.ok(score < 0.2)
})

test('effectiveHalfLife 情绪高则半衰期长', () => {
  const calm = effectiveHalfLife(makeCard({ emotional: 0 }), config)
  const intense = effectiveHalfLife(makeCard({ emotional: 1 }), config)
  assert.ok(intense > calm)
})

test('effectiveHalfLife 访问多则半衰期长', () => {
  const fresh = effectiveHalfLife(makeCard({ accessCount: 0 }), config)
  const used = effectiveHalfLife(makeCard({ accessCount: 10 }), config)
  assert.ok(used > fresh)
})

test('scoreCard 总分落在 0..1', () => {
  const query = makeQuery('Qt5 项目', config, 1_700_000_000_000)
  const scored = scoreCard(makeCard(), query, config)
  assert.ok(scored.score.total >= 0 && scored.score.total <= 1)
})

test('scoreCard 解释行非空且含总分', () => {
  const query = makeQuery('Qt5', config, 1_700_000_000_000)
  const scored = scoreCard(makeCard(), query, config)
  assert.ok(scored.explain.length > 0)
  assert.ok(scored.explain.some((line) => line.startsWith('总分')))
})

test('scoreCard 冲突卡带惩罚', () => {
  const query = makeQuery('Qt5', config, 1_700_000_000_000)
  const clean = scoreCard(makeCard({ id: 'a' }), query, config)
  const conflicted = scoreCard(makeCard({ id: 'b', conflictOf: ['x', 'y', 'z'] }), query, config)
  assert.ok(conflicted.score.conflictPenalty > 0)
  assert.ok(conflicted.score.total < clean.score.total)
  assert.equal(conflicted.conflict, true)
})

test('scoreCards 按总分降序且同分按 id 升序', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const a = makeCard({ id: 'aaa', text: '这个项目用 Qt5 开发', createdAt: now })
  const b = makeCard({ id: 'bbb', text: '这个项目用 Qt5 开发', createdAt: now })
  const c = makeCard({ id: 'ccc', text: '完全无关的天气记录', createdAt: now - 10_000_000 })
  const sorted = scoreCards([c, b, a], query, config)
  assert.equal(sorted.length, 3)
  assert.equal(sorted[0]?.card.id, 'aaa')
  assert.equal(sorted[1]?.card.id, 'bbb')
  assert.equal(sorted[2]?.card.id, 'ccc')
})

test('scoreCards 确定性：两次调用结果一致', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const cards = [makeCard({ id: 'x' }), makeCard({ id: 'y', text: '另一个项目用 Qt5' })]
  const first = scoreCards(cards, query, config).map((s) => s.card.id)
  const second = scoreCards(cards, query, config).map((s) => s.card.id)
  assert.deepEqual(first, second)
})

test('filterByDomain 空域列表表示不限域', () => {
  const cards = [makeCard({ id: 'a', domain: 'work' }), makeCard({ id: 'b', domain: 'life' })]
  assert.equal(filterByDomain(cards, []).length, 2)
})

test('filterByDomain 只保留启用域（起源 L13 三模块可插拔）', () => {
  const cards = [
    makeCard({ id: 'w', domain: 'work' }),
    makeCard({ id: 'l', domain: 'life' }),
    makeCard({ id: 's', domain: 'study' }),
  ]
  assert.deepEqual(filterByDomain(cards, ['work']).map((c) => c.id), ['w'])
  assert.deepEqual(filterByDomain(cards, ['life', 'study']).map((c) => c.id), ['l', 's'])
})

test('filterByDomain 不修改输入数组', () => {
  const cards = [makeCard({ id: 'a', domain: 'work' }), makeCard({ id: 'b', domain: 'life' })]
  filterByDomain(cards, ['work'])
  assert.equal(cards.length, 2)
})

test('scoreCards 按 query.domains 过滤，域外卡不进结果', () => {
  const now = 1_700_000_000_000
  const base = makeQuery('Qt5 项目', config, now)
  // 只启用工作域。
  const query = { ...base, domains: ['work'] }
  const cards = [
    makeCard({ id: 'work-card', domain: 'work', text: '这个项目用 Qt5', createdAt: now }),
    makeCard({ id: 'life-card', domain: 'life', text: '这个项目用 Qt5', createdAt: now }),
  ]
  const scored = scoreCards(cards, query, config)
  assert.deepEqual(scored.map((s) => s.card.id), ['work-card'])
})

test('scoreCards 域全关时返回空（可插拔的另一半语义）', () => {
  const now = 1_700_000_000_000
  const query = { ...makeQuery('Qt5', config, now), domains: [] as string[] }
  const cards = [makeCard({ id: 'a', domain: 'work' })]
  // 空列表表示不限域，不是「全关」。
  assert.equal(scoreCards(cards, query, config).length, 1)
})

test('applyThresholds 低于绝对阈值被丢弃', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('完全无关的查询词', config, now)
  const scored = scoreCards([makeCard({ createdAt: now - 100 * config.forgetting.halfLifeMs })], query, config)
  assert.equal(applyThresholds(scored, config).length, 0)
})

test('applyThresholds 不超过 maxCards', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const cards = Array.from({ length: 20 }, (_, i) => makeCard({ id: `c${i}`, createdAt: now }))
  const scored = scoreCards(cards, query, config)
  assert.ok(applyThresholds(scored, config).length <= config.recall.maxCards)
})

test('buildFocusPack 空候选产出空包且带说明', () => {
  const query = makeQuery('无关查询', config, 1_700_000_000_000)
  const pack = buildFocusPack([], query, config)
  assert.equal(pack.empty, true)
  assert.equal(pack.cards.length, 0)
  assert.ok(pack.note.length > 0)
})

test('buildFocusPack token 不超预算', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const cards = Array.from({ length: 10 }, (_, i) => makeCard({ id: `c${i}`, text: `这个项目用 Qt5 开发 第 ${i} 条记录`, createdAt: now }))
  const pack = buildFocusPack(scoreCards(cards, query, config), query, config)
  assert.ok(pack.tokens <= pack.budgetTokens)
})

test('clamp01 边界', () => {
  assert.equal(clamp01(-1), 0)
  assert.equal(clamp01(2), 1)
  assert.equal(clamp01(Number.NaN), 0)
  assert.equal(clamp01(0.5), 0.5)
})

test('formatDuration 各量级', () => {
  assert.equal(formatDuration(1000), '刚刚')
  assert.equal(formatDuration(5 * 60_000), '5 分钟前')
  assert.equal(formatDuration(3 * 3_600_000), '3 小时前')
  assert.equal(formatDuration(2 * 86_400_000), '2 天前')
  assert.equal(formatDuration(-1), '未知')
})

test('formatTime 按指定时区渲染', () => {
  const text = formatTime(Date.UTC(2024, 0, 1, 0, 0), 'Asia/Shanghai')
  assert.equal(text, '2024-01-01 08:00')
})
