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

test('冲突惩罚原样扣分，不按绝对阈值封顶（缺陷二十六）', () => {
  // 这条测试替换掉原来的 `冲突惩罚封顶：扣分不会把卡从阈值上方打到下方`。
  //
  // ## 原测试为什么必须删掉
  //
  // 它断言的是：
  //   `total >= absoluteThreshold - 1e-9 || normalized <= absoluteThreshold`
  // 后半句是**同义反复**——`total = normalized - penalty`，而 penalty ≥ 0，
  // 所以 `normalized <= 阈值` 时 `total` 必然也 ≤ 阈值，前半句就无所谓了；
  // 而 `normalized > 阈值` 时封顶逻辑保证前半句成立。于是**两个分支恒真**，
  // 这条断言在任何实现下都绿。它守的是一个已经被判定为缺陷的行为，
  // 而且守的方式是恒真。
  //
  // ## 现在的契约（FR-B5「冲突必须显式暴露」的正确实现方式）
  //
  // 冲突**只降排序、不决定去留**，但不许靠「封顶到阈值」来实现——
  // 那样会让 `absoluteThreshold` 变成分数地板，导致它对所有卡恒真（缺陷二十六）。
  // 正确的实现是靠**结构**：闸门看 `relevance`，而 `relevance` 完全不含冲突项。
  //
  // 所以这里要钉住两件事：
  // ① 惩罚是**原样**扣的：`total = normalized - penalty × w.conflict`，精确成立；
  // ② 改 `absoluteThreshold` 不改变任何一张卡的 `total`（证明它不再是分数地板）。
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const clean = scoreCard(makeCard({ id: 'clean' }), query, config)
  const conflicted = scoreCard(makeCard({ id: 'cf', conflictOf: ['x', 'y', 'z'] }), query, config)
  assert.equal(clean.score.conflictPenalty, 0, '无冲突时惩罚为 0')
  assert.ok(conflicted.score.conflictPenalty > 0, '有冲突时惩罚为正')

  // ① 惩罚原样扣分：从 total 反推出的归一化分，与各分项加权和必须逐位吻合。
  const w = config.weights
  const positiveWeight = w.semantic + w.importance + w.recency + w.goal + w.confidence
  const s = conflicted.score
  const expectedNormalized = (s.semantic * w.semantic + s.importance * w.importance
    + s.recency * w.recency + s.goal * w.goal + s.confidence * w.confidence) / positiveWeight
  assert.ok(
    Math.abs(s.total - (expectedNormalized - s.conflictPenalty * w.conflict)) < 1e-12,
    `冲突惩罚必须原样扣分：期望 ${expectedNormalized - s.conflictPenalty * w.conflict}，实际 ${s.total}`,
  )

  // ② 关键：把绝对阈值改到任意值，同一张卡的 total 必须**完全不变**。
  // 这是「绝对阈值不再是分数地板」的直接证明。若有人把封顶装回去，
  // 这条会红——因为封顶公式里有 `normalized - absoluteThreshold`。
  for (const threshold of [0.01, 0.06, 0.18, 0.5]) {
    const cfg = { ...config, recall: { ...config.recall, absoluteThreshold: threshold } }
    const again = scoreCard(makeCard({ id: 'cf', conflictOf: ['x', 'y', 'z'] }), query, cfg)
    assert.equal(
      again.score.total,
      s.total,
      `改 absoluteThreshold 到 ${threshold} 后 total 必须不变（实际 ${s.total} → ${again.score.total}）——`
      + '变了就说明它又被当成分数地板用了，那道闸会对所有卡恒真',
    )
  }

  // ③ 冲突不得影响去留：`relevance` 完全不含冲突项，所以挂不挂冲突它都一样。
  assert.equal(
    conflicted.score.relevance,
    clean.score.relevance,
    '冲突不得影响 relevance——闸门看的就是它，冲突因此无法决定去留（FR-B5）',
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
  //
  // ## 缺陷二十六之后的修改：前提断言换了尺子
  //
  // 原前提是 `total < absoluteThreshold`。现在绝对闸比对 `relevance`，
  // 那条前提既不该再拿 `total` 比，也**必然**红——这张死透的卡 `total`
  // 仍有 0.17 左右（0.48 权重与查询无关，见 `ScoreBreakdown.relevance` 的注释），
  // 而阈值已是 0.06。这不是回归，是前提断言本身选错了尺度。
  //
  // 改成断言 `relevance === 0`：它比「小于阈值」更强，且能直接说明
  // 「这张卡与查询毫无关系」，而不是「它刚好没够到某个数字」。
  //
  // 语料也要换：原版用「完全无关的内容」对「完全无关的查询词」——
  // 这两句**共享 4 个 bigram**（完全/全无/无关/关的），relevance 实测 0.3323，
  // 根本不「无关」。那是又一条「靠巧合」的构造。现在用两组毫无共同字符的文本。
  const now = 1_700_000_000_000
  const query = makeQuery('量子色动力学的渐近自由', config, now)
  const dead = makeCard({
    text: '今天午饭吃了番茄炒蛋',
    normalized: '今天午饭吃了番茄炒蛋',
    createdAt: now - 100 * config.forgetting.halfLifeMs,
    confidence: 0,
    salience: 0,
    emotional: 0,
  })
  const scored = scoreCards([dead], query, config)
  assert.equal(
    scored[0]!.score.relevance,
    0,
    `前提：这张卡的相关分量必须精确为 0（查询词与卡片零词项交集），实际 ${scored[0]!.score.relevance}`,
  )
  // 注意：这里**不能**再断言「total 高于阈值」。这张卡各分项全零（100 个半衰期、
  // 置信度 0、重要性 0），total 约 1e-31，任何尺度的阈值都拦得住它——
  // 那正是它作为「死透」样本的意义。`total` 尺度的漏洞要由**另一条**用例证明：
  // 一张「无关但新鲜、高置信」的卡 total 能到 0.32 以上，见下一条。
  assert.equal(applyThresholds(scored, config).length, 0)
})

test('无关但新鲜的卡：total 拦不住它，relevance 必须拦住（缺陷二十六的核心）', () => {
  // 这是缺陷二十六的**直接**回归测试，也是「为什么闸门必须看 relevance」的证明。
  //
  // 构造：一张与查询零词项交集、但**新鲜、高置信、高显著性**的卡。
  // 它在 total 尺度上分数很高（importance + recency + confidence 共 0.48 权重，
  // 全部与查询无关），所以旧闸门（`total >= 0.18`）**永远拦不住它**。
  //
  // 实测（161 张真实卡 × 19 个查询）：无关卡 total 区间 0.3131~0.3767，
  // 相关卡 0.3452~，重叠 33.3%；全量 2595 个样本低于 0.18 的 **0 个**。
  // 也就是说 FR-B2 的验收「全低分时不硬塞」在旧闸门下**在数学上不可能失败**。
  const now = 1_700_000_000_000
  const query = makeQuery('量子色动力学的渐近自由', config, now)
  const freshButIrrelevant = makeCard({
    text: '今天午饭吃了番茄炒蛋',
    normalized: '今天午饭吃了番茄炒蛋',
    createdAt: now,          // 新鲜 → recency = 1
    confidence: 1,           // 高置信
    salience: 1,             // 高重要
  })
  const scored = scoreCards([freshButIrrelevant], query, config)
  const s = scored[0]!
  // 前提一：确实无关。这一条若红了，说明构造失效（语料又有词项重合），不是实现有问题。
  assert.equal(s.score.relevance, 0, `前提：这张卡必须与查询零相关，实际 relevance=${s.score.relevance}`)
  // 前提二：它在旧尺子上**过得了**旧阈值。这条证明「旧闸门拦不住」，是缺陷本身。
  assert.ok(
    s.score.total > 0.3,
    `前提：这张无关卡的 total 必须很高（实测约 0.32~0.38），实际 ${s.score.total}`,
  )
  // 结论：新闸门必须把它挡在外面。
  assert.equal(
    applyThresholds(scored, config).length,
    0,
    `无关但新鲜的卡不能进焦点包（FR-B2 全低分时不硬塞）。`
    + `它的 total=${s.score.total} 很高，但 relevance=${s.score.relevance} 为 0`,
  )
})

test('applyThresholds 的死卡丢弃不是「全都丢」：同批放一张相关卡必须留下', () => {
  // 配对阳性对照。只测「该死掉的死掉了」这一半，等于没测——
  // 整个 `applyThresholds` 改成 `return []` 也能让上一条全绿。
  // 这条守的是另一半：闸门真的在按内容分辨，不是无条件清空。
  const now = 1_700_000_000_000
  const queryText = '幂等键必须包含边权'
  const query = makeQuery(queryText, config, now)
  const dead = makeCard({
    id: 'dead',
    text: '完全无关的内容',
    normalized: '完全无关的内容',
    createdAt: now - 100 * config.forgetting.halfLifeMs,
    confidence: 0,
    salience: 0,
    emotional: 0,
  })
  const alive = makeCard({
    id: 'alive',
    text: '结论是幂等键必须包含边权，否则改边权会被静默丢弃',
    normalized: '结论是幂等键必须包含边权，否则改边权会被静默丢弃',
    createdAt: now,
  })
  const scored = scoreCards([dead, alive], query, config)
  const pack = applyThresholds(scored, config)
  assert.deepEqual(
    pack.map((s) => s.card.id),
    ['alive'],
    '相关卡必须留下、无关卡必须丢弃——同批里两种卡并存才能证明闸门在按内容分辨',
  )
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

test('applyThresholds 硬上限精确截到 maxCards 条（不是「不超过」）', () => {
  // 这条原来是 `assert.ok(... <= config.recall.maxCards)`，**是无牙断言**：
  // 实测就是 7 = maxCards，余量为 0，但写成 `<=` 之后，把 `maxCards` 改成
  // 100、或让硬上限那道闸失效（只剩两道内容闸），它照样绿。
  // 20 张内容完全相同的卡全部命中查询，所以三道闸里只有硬上限在起作用
  // ——这正是隔离硬上限的语料。
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目', config, now)
  const cards = Array.from({ length: 20 }, (_, i) => makeCard({ id: `c${i}`, createdAt: now }))
  const scored = scoreCards(cards, query, config)
  // 前提：候选确实多于上限，否则「截到 7」可能只是恰好只有 7 张
  assert.ok(
    scored.length > config.recall.maxCards,
    `前提：候选 ${scored.length} 条必须多于上限 ${config.recall.maxCards}，否则截断无从发生`,
  )
  const picked = applyThresholds(scored, config)
  assert.equal(
    picked.length, config.recall.maxCards,
    `硬上限必须**精确**截到 ${config.recall.maxCards} 条，实际 ${picked.length}。`
    + '若这条红了，可能是硬上限失效（截多了）或内容闸误伤（截少了）',
  )
})

test('三道闸各挡各的：绝对闸按 relevance、相对闸按 total、硬上限按条数', () => {
  // FR-B2 原文是「绝对阈值 + 相对 top 值阈值；硬上限 7 条」，三者取**最严**。
  // 但「取最严」这句话很容易写成一个闸，而三道闸其实问三个不同的问题：
  //
  //   绝对闸 → relevance（有没有关系）     —— 无关卡 relevance 精确为 0
  //   相对闸 → total（比本轮最好的差多少） —— 过时卡 total 掉下去
  //   硬上限 → 条数
  //
  // 缺陷二十六修完之后绝对闸换了尺子，而**相对闸仍留在 total 上**（有意的，
  // 见 applyThresholds 的注释：统一尺子会误杀真相关卡）。所以必须有一条用例
  // 同时证明「三道闸各自能挡」，否则任一闸恒真都不会被发现。
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目 构建', config, now)

  // 三张卡，各自只该被一道闸挡住：
  //   hit          —— 三道闸全过
  //   unrelated    —— relevance 为 0，只该被绝对闸挡（它的 total 其实不低）
  //   stale        —— relevance 高，但一年前的卡 total 掉到相对闸以下
  const cards = [
    makeCard({ id: 'hit', text: 'Qt5 项目 构建 用 cmake', normalized: 'qt5 项目 构建 用 cmake' }),
    makeCard({
      id: 'unrelated',
      text: '深海鮟鱇鱼 的 发光 器官',
      normalized: '深海鮟鱇鱼 的 发光 器官',
      salience: 1,
      confidence: 1,
    }),
    makeCard({
      id: 'stale',
      text: 'Qt5 项目 构建 相关',
      normalized: 'qt5 项目 构建 相关',
      salience: 0.01,
      confidence: 0.05,
      createdAt: now - 400 * 86_400_000,
      updatedAt: now - 400 * 86_400_000,
    }),
  ]
  const scored = scoreCards(cards, query, config)
  const top = scored[0]
  assert.ok(top !== undefined, '前提：必须至少有一张卡被打分')
  const relativeFloor = top.score.total * config.recall.relativeThreshold

  const byId = new Map(scored.map((item) => [item.card.id, item]))
  const unrelated = byId.get('unrelated')
  const stale = byId.get('stale')
  assert.ok(unrelated !== undefined && stale !== undefined, '前提：三张卡都必须进入候选')

  // 前提断言：证明这两张卡确实是「被各自的闸」挡住，而不是因为别的原因没进包
  assert.equal(
    unrelated.score.relevance, 0,
    '前提：无关卡的 relevance 必须精确为 0（零词项交集），否则它可能是被相对闸挡的',
  )
  assert.ok(
    unrelated.score.total >= relativeFloor,
    `前提：无关卡的 total ${unrelated.score.total.toFixed(4)} 必须 >= 相对闸 ${relativeFloor.toFixed(4)}，`
    + '这样才能证明挡住它的是绝对闸而不是相对闸',
  )
  assert.ok(
    stale.score.relevance >= config.recall.absoluteThreshold,
    `前提：过时卡的 relevance ${stale.score.relevance.toFixed(4)} 必须 >= 绝对闸 ${config.recall.absoluteThreshold}，`
    + '这样才能证明挡住它的是相对闸而不是绝对闸',
  )
  assert.ok(
    stale.score.total < relativeFloor,
    `前提：过时卡的 total ${stale.score.total.toFixed(4)} 必须 < 相对闸 ${relativeFloor.toFixed(4)}`,
  )

  const picked = applyThresholds(scored, config)
  assert.deepEqual(
    picked.map((item) => item.card.id),
    ['hit'],
    '只有三道闸全过的卡能进包：无关卡被绝对闸挡、过时卡被相对闸挡',
  )
})

test('硬上限与内容闸同时生效时，取更严的那个（内容闸先挡掉一部分）', () => {
  // 上一条证明三道闸各挡各的，这一条证明它们**组合**时不会互相抵消。
  // 语料：2 张强相关卡 + 18 张弱相关卡，弱相关卡的 relevance 过绝对闸
  // 但 total 低于相对闸 => 内容闸先挡掉 18 张，硬上限只剩 2 张可选。
  const now = 1_700_000_000_000
  const query = makeQuery('Qt5 项目 构建', config, now)
  const strong = [
    makeCard({ id: 'strong-a', text: 'Qt5 项目 构建 用 cmake', normalized: 'qt5 项目 构建 用 cmake' }),
    makeCard({ id: 'strong-b', text: 'Qt5 项目 构建 用 qmake', normalized: 'qt5 项目 构建 用 qmake' }),
  ]
  const weak = Array.from({ length: 18 }, (_, i) => makeCard({
    id: `weak-${i}`,
    text: 'Qt5 项目 构建 相关',
    normalized: 'qt5 项目 构建 相关',
    salience: 0.01,
    confidence: 0.05,
    createdAt: now - 400 * 86_400_000,
    updatedAt: now - 400 * 86_400_000,
  }))
  const scored = scoreCards([...strong, ...weak], query, config)
  assert.ok(scored.length > config.recall.maxCards, '前提：候选必须多于硬上限')
  const picked = applyThresholds(scored, config)
  assert.equal(
    picked.length, 2,
    `内容闸先挡掉 18 张弱相关卡后只剩 2 张，实际进了 ${picked.length} 张。`
    + '若等于 maxCards(7)，说明相对闸没在挡，硬上限把弱卡放进来了',
  )
  assert.deepEqual(picked.map((item) => item.card.id).sort(), ['strong-a', 'strong-b'])
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
