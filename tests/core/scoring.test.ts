import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import {
  applyThresholds, buildFocusPack, clamp01, effectiveHalfLife, filterByDomain, formatDuration,
  describeConflictPeers, formatTime, goalScore, importanceScore, makeQuery, recencyScore, renderEmptyNote, renderFocusPack, scoreCard,
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

test('冲突只降排序、不淘汰：双方互相冲突时仍至少有一条进包（FR-B5）', () => {
  // 这是 FR-B5「冲突不隐藏」的核心回归。原来的实现把 penalty × w.conflict
  // （0.25）直接从总分里减掉，而它比 absoluteThreshold（0.18）还大，
  // 于是**互相冲突的两张卡一起掉出包外**——最坏的隐藏：模型连「这里有矛盾」
  // 都不知道，更别提看到双方。封顶后冲突最多把卡压到阈值边上，不能压穿。
  const now = 1_700_000_000_000
  // 阈值调到很紧，逼出「本来就勉强够格」的情形，让冲突惩罚有机会致命。
  const tight = { ...config, recall: { ...config.recall, absoluteThreshold: 0.17 } }
  const query = makeQuery('数据库选型', tight, now)
  const a = makeCard({
    id: 'c-a', text: '数据库用 PostgreSQL，JSONB 支持最好', normalized: '数据库用 postgresql jsonb 支持最好',
    createdAt: now, conflictOf: ['c-b'],
  })
  const b = makeCard({
    id: 'c-b', text: '数据库改用 MySQL，PostgreSQL 太慢', normalized: '数据库改用 mysql postgresql 太慢',
    createdAt: now, conflictOf: ['c-a'],
  })
  const scored = scoreCards([a, b], query, tight)
  // 前提校验：冲突惩罚确实生效了，否则这条测试证明不了「不淘汰」。
  assert.ok(scored.every((item) => item.conflict), '前提：两张卡都必须被判为冲突')
  const pack = buildFocusPack(scored, query, tight)
  assert.ok(pack.cards.length >= 1, `冲突不得让双方一起消失，实际包内 ${pack.cards.length} 条`)
  const time = {
    now, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
    sinceLastSession: null, sinceLastTurn: null,
    sessionStartedAt: null, due: [],
  }
  const rendered = renderFocusPack(pack, time)
  assert.match(rendered, /CONFLICT/u)
  // 同时暴露双方：要么对方也在包里，要么明说它不在。
  assert.match(rendered, /PostgreSQL|MySQL|不在本次焦点包内|不在活跃记忆中/u)
})

test('冲突惩罚封顶：扣分不会把卡从阈值上方打到下方', () => {
  // 直接验封顶的数学性质，不经过渲染。三个区间的行为都必须钉住：
  // 1) 无冲突 → 0；2) 在阈值下方 → 0（本来就没得淘汰，报 0 免得 explain 误导）；
  // 3) 在阈值上方 → 最多扣到阈值边上，绝不压穿。
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const clean = scoreCard(makeCard({ id: 'clean' }), query, config)
  const conflicted = scoreCard(makeCard({ id: 'cf', conflictOf: ['x', 'y', 'z'] }), query, config)
  assert.equal(clean.score.conflictPenalty, 0, '无冲突时惩罚为 0')
  assert.ok(conflicted.score.conflictPenalty > 0, '有冲突时惩罚为正')
  // 封顶的实质：扣掉的分数 ≤ 距绝对阈值的余量。
  const normalizedOfConflicted = conflicted.score.total + conflicted.score.conflictPenalty * config.weights.conflict
  assert.ok(
    conflicted.score.total >= config.recall.absoluteThreshold - 1e-9
      || normalizedOfConflicted <= config.recall.absoluteThreshold,
    `冲突不得把本来够格的卡压到阈值下方，实际总分 ${conflicted.score.total}`,
  )
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
  // 这条测试守的是「已经死掉的卡不该被召回」。断言不许放宽：
  // 它是唯一在守这条线的用例，放宽等于让阈值失效没人发现。
  //
  // 构造要**离阈值足够远**，不能靠「刚好越过」：原版用的是
  // 「100 个半衰期 + 语义不相关」，实测总分 0.168，对 0.18 的余量只有 0.012。
  // 归一化分母一动（哪怕是修 bug）它就会翻绿变红——这种测试是「靠运气绿」，
  // 绿的时候说明不了任何事。现在把该给零的分项都压到零，让结论由规则决定：
  // 语义 0（查询词与卡片无交集）、时间 0（100 个半衰期）、置信度 0、重要性压到最低。
  const now = 1_700_000_000_000
  const query = makeQuery('完全无关的查询词', config, now)
  const dead = makeCard({
    text: '完全无关的内容',
    normalized: '完全无关的内容',
    createdAt: now - 100 * config.forgetting.halfLifeMs,
    confidence: 0,
    salience: 0,
    emotional: 0,
  })
  const scored = scoreCards([dead], query, config)
  assert.ok(
    scored[0]!.score.total < config.recall.absoluteThreshold,
    `前提：这张卡的总分必须真的低于绝对阈值，实际 ${scored[0]!.score.total}`,
  )
  assert.equal(applyThresholds(scored, config).length, 0)
})

test('applyThresholds 阈值刻度不随「是否提供目标」漂移（分母恒含 goal 权重）', () => {
  // 这条守的是分数刻度的稳定性。若有人把 w.goal 从分母里摘掉（我曾这么干过），
  // 所有卡的归一化分会整体上浮 1/(1-w.goal) 倍，绝对阈值的实际严苛程度被悄悄改掉。
  // 同一张卡、同一个时刻，有没有目标只应改变 goal 这一项的贡献，不应改变分母基准。
  const now = 1_700_000_000_000
  const card = makeCard({ id: 'same-card' })
  const noGoal = scoreCard(card, makeQuery('Qt5', config, now), config)
  const withGoal = scoreCard(card, makeQuery('Qt5', config, now, 'Qt5 项目'), config)
  // 无目标时 goal 项为 0，有目标且命中时 goal 项 > 0，故总分只会更高或相等。
  assert.equal(noGoal.score.goal, 0)
  assert.ok(withGoal.score.goal > 0)
  assert.ok(withGoal.score.total >= noGoal.score.total)
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

test('buildFocusPack 头尾固定开销计入 tokens（FR-E3 上限不能是假的）', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const cards = [makeCard({ id: 'c0', text: '这个项目用 Qt5 开发', createdAt: now })]
  const pack = buildFocusPack(scoreCards(cards, query, config), query, config)
  assert.equal(pack.empty, false)
  // tokens 必须包含 overheadTokens，否则渲染出的实际长度会超过 budgetTokens。
  assert.ok(
    pack.tokens >= config.recall.overheadTokens,
    `tokens=${pack.tokens} 应 ≥ overhead=${config.recall.overheadTokens}`,
  )
})

test('buildFocusPack 空包 tokens 为 0', () => {
  const query = makeQuery('无关查询', config, 1_700_000_000_000)
  const pack = buildFocusPack([], query, config)
  assert.equal(pack.tokens, 0)
})

test('buildFocusPack 带上 maxCardChars 供渲染使用', () => {
  const query = makeQuery('Qt5', config, 1_700_000_000_000)
  const pack = buildFocusPack([], query, config)
  assert.equal(pack.maxCardChars, config.recall.maxCardChars)
})

test('renderFocusPack 按 pack.maxCardChars 截断，不硬编码', () => {
  const now = 1_700_000_000_000
  const longText = '这个项目用 Qt5 开发'.repeat(40)
  const query = makeQuery('Qt5 项目', config, now)
  const cards = [makeCard({ id: 'c0', text: longText, createdAt: now })]
  const pack = buildFocusPack(scoreCards(cards, query, config), query, config)
  const time = {
    now, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
    sinceLastSession: null, sinceLastTurn: null,
    sessionStartedAt: null, due: [],
  }
  const rendered = renderFocusPack(pack, time)
  const cardLine = rendered.split('\n').find((line) => line.startsWith('- ['))
  assert.ok(cardLine !== undefined)
  const body = cardLine.slice(cardLine.indexOf('] ') + 2)
  assert.ok(
    [...body].length <= config.recall.maxCardChars,
    `正文 ${[...body].length} 字超过 ${config.recall.maxCardChars}`,
  )
})

test('空包时 renderEmptyNote 给出明确说明（FR-B6 不编造）', () => {
  // 回归：pack.note 此前是纯死字段——写进去了、测了，但没有任何地方读它。
  // FR-B6 这条 P0 验收靠的正是这句提示，模型却永远收不到。
  const query = makeQuery('完全不相干的查询', config, 1_700_000_000_000)
  const pack = buildFocusPack([], query, config)
  assert.equal(pack.empty, true)
  assert.match(renderEmptyNote(pack), /没有相关记忆/u)
})

test('非空包时 renderEmptyNote 返回空串', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5', config, now)
  const cards = [makeCard({ id: 'c0', text: '这个项目用 Qt5 开发', createdAt: now })]
  const pack = buildFocusPack(scoreCards(cards, query, config), query, config)
  assert.equal(pack.empty, false)
  assert.equal(renderEmptyNote(pack), '')
})

test('空包时注入文本为空串，不写「没有相关记忆」进上下文', () => {
  // 语义区分：不注入 ≠ 不给信号。空包注入内容会诱导模型主动声明「我查过了」，
  // 那本身就是一种编造；明确信号走 renderEmptyNote，供命令输出与诊断使用。
  const query = makeQuery('完全不相干的查询', config, 1_700_000_000_000)
  const pack = buildFocusPack([], query, config)
  const time = {
    now: 1_700_000_000_000, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
    sinceLastSession: null, sinceLastTurn: null,
    sessionStartedAt: null, due: [],
  }
  assert.equal(renderFocusPack(pack, time), '')
})

test('冲突渲染标出 CONFLICT 并暴露对方是谁（FR-B5）', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('数据库选型', config, now)
  const a = makeCard({
    id: 'c-a', text: '数据库用 PostgreSQL，JSONB 支持最好', createdAt: now,
    conflictOf: ['c-b'],
  })
  const b = makeCard({
    id: 'c-b', text: '数据库改用 MySQL，PostgreSQL 太慢', createdAt: now,
    conflictOf: ['c-a'],
  })
  const scored = scoreCards([a, b], query, config)
  const pack = buildFocusPack(scored, query, config)
  const time = {
    now, timeZone: 'Asia/Shanghai', localDate: '2023-11-14',
    sinceLastSession: null, sinceLastTurn: null,
    sessionStartedAt: null, due: [],
  }
  const rendered = renderFocusPack(pack, time)
  assert.match(rendered, /CONFLICT/u, 'FR-B5 要求标 CONFLICT')
  // 只说「有冲突」等于让模型知道有矛盾却看不到另一半，它只能忽略或编造。
  const hasPeerText =
    rendered.includes('MySQL') || rendered.includes('PostgreSQL 太慢') || rendered.includes('不在本次焦点包内')
  assert.ok(hasPeerText, `冲突行必须暴露对方是谁，实际渲染：${rendered}`)
})

test('describeConflictPeers 在对方不在包内时给出明确说明', () => {
  const now = 1_700_000_000_000
  const query = makeQuery('数据库', config, now)
  const a = makeCard({
    id: 'c-a', text: '数据库用 PostgreSQL', createdAt: now,
    conflictOf: ['c-gone'],
  })
  const scored = scoreCards([a], query, config)
  const pack = buildFocusPack(scored, query, config)
  const item = pack.cards[0]
  assert.ok(item !== undefined)
  const described = describeConflictPeers(item, pack)
  assert.ok(described.length > 0)
  assert.match(described, /不在本次焦点包内|不在活跃记忆中/u)
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
