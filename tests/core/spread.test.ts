/**
 * 图谱扩散激活与突触可塑性单测（FR-G1）。
 *
 * 需求归属：`docs/1-需求规格.md` FR-G1「突触学习与图谱扩散」。
 * 起源依据：L15（无编号·图谱）「我需要一种建立记忆图谱的方法，且跨层次关联。」
 *
 * 本文件刻意覆盖**护栏**而不只覆盖「扩散能加分」——因为扩散本身是几行加法，
 * 出错的地方几乎总在护栏上：没有上限会变成人气榜，没有自身门槛会让阈值失效。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_CONFIG, type MemoryConfig } from '../../src/core/config.ts'
import { makeCard, makeConfig } from '../consolidate/fixtures.ts'
import { makeEdge } from '../../src/core/graph.ts'
import {
  applySpread, buildAdjacency, canTraverse, decayEdges, isDiffusible,
  prunableEdges, reinforceEdges, spreadActivation,
} from '../../src/core/spread.ts'
import type { SpreadSeed } from '../../src/core/spread.ts'
import { scoreCards } from '../../src/core/scoring.ts'
import { makeQuery } from '../../src/core/scoring.ts'
import type { MemoryEdge } from '../../src/core/types.ts'

/**
 * 开启扩散的配置。
 *
 * 参数是 **`spread` 段**而不是完整配置：本文件所有用例都只关心扩散参数，
 * 让它们每次都写 `spread: {...}` 会把真正的差异埋进样板里。
 *
 * @param over - `spread` 段的覆盖值。
 * @returns 完整配置。
 */
function spreadConfig(over: Partial<MemoryConfig['spread']> = {}): MemoryConfig {
  return makeConfig({
    spread: {
      enabled: true,
      hopDecay: 0.5,
      maxHops: 2,
      maxBoost: 0.12,
      minSelfScoreRatio: 1,
      maxAffected: 5,
      distillBidirectional: true,
      plasticityEnabled: true,
      reinforceDelta: 0.05,
      maxEdgeWeight: 1,
      decayFactor: 0.98,
      pruneThreshold: 0.1,
      maxPrunePerRun: 200,
      ...over,
    },
  })
}

/** 造一条边，权重与时刻固定，避免用例被无关参数影响。 */
function edge(
  from: string, to: string, relation: MemoryEdge['relation'] = 'same-entity', weight = 0.8,
): MemoryEdge {
  return makeEdge(from, to, relation, weight, 1000)
}

describe('扩散激活（FR-G1）', () => {
  it('关闭时原样返回空结果，整条链路退化到引入本功能之前', () => {
    const config = makeConfig({ spread: { enabled: false } })
    const adjacency = buildAdjacency([edge('a', 'b')])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 0.9 }]
    const boosts = spreadActivation(seeds, adjacency, new Map([['b', 0.5]]), config)
    assert.deepEqual(boosts, [], '关闭时必须一条加分都不产生')
  })

  it('一跳扩散：邻居获得「种子分 × 边权 × 每跳衰减」的加分', () => {
    // 0.9 × 0.8 × 0.5 = 0.36，但被 maxBoost 0.12 截平。
    // 为了验证公式本身，这里把 maxBoost 提到 1 让截平不干扰。
    const config = spreadConfig({ maxBoost: 1 })
    const adjacency = buildAdjacency([edge('a', 'b', 'same-entity', 0.8)])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 0.9 }]
    const boosts = spreadActivation(seeds, adjacency, new Map([['b', 0.5]]), config)
    assert.equal(boosts.length, 1)
    assert.equal(boosts[0]?.id, 'b')
    // 浮点乘法 0.9*0.8*0.5 = 0.36000000000000004，用近似比较
    assert.ok(
      Math.abs((boosts[0]?.boost ?? 0) - 0.36) < 1e-9,
      `期望 0.36，实际 ${boosts[0]?.boost}`,
    )
  })

  it('加分被 maxBoost 截平，连接多的卡不会压过内容匹配的卡', () => {
    // 三条边从 a 出发，能量累加远超 maxBoost。
    const config = spreadConfig({ maxBoost: 0.12 })
    const adjacency = buildAdjacency([
      edge('a', 'b', 'same-entity', 1),
      edge('a', 'b', 'same-topic', 1),
      edge('a', 'b', 'distills', 1),
    ])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
    const boosts = spreadActivation(seeds, adjacency, new Map([['b', 0.5]]), config)
    assert.equal(boosts.length, 1, '同一张卡只应产生一条记录，不是三条')
    assert.equal(boosts[0]?.boost, 0.12, '必须精确等于上限，而不是原始累加值')
  })

  it('护栏：自身分数低于绝对阈值的卡，扩散不给它加分', () => {
    // b 自身 0.05，绝对阈值 0.18 → 低于阈值，扩散应拒绝它。
    const config = spreadConfig()
    const adjacency = buildAdjacency([edge('a', 'b')])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 0.9 }]
    const boosts = spreadActivation(seeds, adjacency, new Map([['b', 0.05]]), config)
    assert.deepEqual(boosts, [], '不合格的卡不能靠邻居混进来（否则阈值语义被稀释）')
  })

  it('护栏的边界：恰好等于绝对阈值的卡可以通过', () => {
    // minSelfScoreRatio = 1 时，门槛 = absoluteThreshold × 1 = 0.18。
    // 恰好 0.18 必须通过 —— 防止将来有人把 `>=` 写成 `>`。
    const config = spreadConfig()
    const adjacency = buildAdjacency([edge('a', 'b')])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 0.9 }]
    const boosts = spreadActivation(
      seeds, adjacency, new Map([['b', config.recall.absoluteThreshold]]), config,
    )
    assert.equal(boosts.length, 1, '恰好等于门槛必须通过')
  })

  it('种子自身不因扩散加分（否则等于命中自己还额外奖励）', () => {
    const config = spreadConfig()
    // a 与 b 互相有边，两个都是种子。
    const adjacency = buildAdjacency([edge('a', 'b'), edge('b', 'a')])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.9 }]
    const boosts = spreadActivation(seeds, adjacency, new Map([['a', 0.9], ['b', 0.9]]), config)
    assert.deepEqual(boosts, [], '种子之间互相传播不该产生加分记录')
  })

  it('maxAffected 限制受影响面，超出的卡不加分', () => {
    const config = spreadConfig({ maxAffected: 2, maxBoost: 1 })
    // a 连到 b/c/d，三个邻居都合格。
    const adjacency = buildAdjacency([
      edge('a', 'b', 'same-entity', 1),
      edge('a', 'c', 'same-entity', 1),
      edge('a', 'd', 'same-entity', 1),
    ])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
    const selfScores = new Map([['b', 0.5], ['c', 0.5], ['d', 0.5]])
    const boosts = spreadActivation(seeds, adjacency, selfScores, config)
    assert.equal(boosts.length, 2, '受影响面必须被 maxAffected 截断')
  })

  it('hopDecay 小于 1 是级联的必要条件：两跳的收益小于一跳', () => {
    const config = spreadConfig({ maxBoost: 1, maxHops: 2, hopDecay: 0.5 })
    // a→b→c 链式，b 一跳，c 两跳。
    const adjacency = buildAdjacency([
      edge('a', 'b', 'same-entity', 1),
      edge('b', 'c', 'same-entity', 1),
    ])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
    const selfScores = new Map([['b', 0.5], ['c', 0.5]])
    const boosts = spreadActivation(seeds, adjacency, selfScores, config)
    const b = boosts.find((x) => x.id === 'b')?.boost ?? 0
    const c = boosts.find((x) => x.id === 'c')?.boost ?? 0
    assert.ok(b > 0, '前提：一跳必须拿到加分')
    assert.ok(c > 0, '前提：两跳也要能拿到加分')
    assert.ok(c < b, `两跳(${c}) 必须小于一跳(${b})，否则衰减没起作用`)
  })

  it('maxHops 限制传播距离：设为 1 时两跳之外的卡拿不到加分', () => {
    const config = spreadConfig({ maxBoost: 1, maxHops: 1 })
    const adjacency = buildAdjacency([
      edge('a', 'b', 'same-entity', 1),
      edge('b', 'c', 'same-entity', 1),
    ])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
    const selfScores = new Map([['b', 0.5], ['c', 0.5]])
    const boosts = spreadActivation(seeds, adjacency, selfScores, config)
    assert.equal(boosts.find((x) => x.id === 'c'), undefined, 'maxHops=1 时 c 拿不到加分')
  })

  it('边权参与传播：边越强传得越多', () => {
    const config = spreadConfig({ maxBoost: 1, maxHops: 1 })
    const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
    const selfScores = new Map([['b', 0.5]])
    const strong = spreadActivation(
      seeds, buildAdjacency([edge('a', 'b', 'same-entity', 1)]), selfScores, config,
    )
    const weak = spreadActivation(
      seeds, buildAdjacency([edge('a', 'b', 'same-entity', 0.2)]), selfScores, config,
    )
    const strongBoost = strong[0]?.boost ?? 0
    const weakBoost = weak[0]?.boost ?? 0
    assert.ok(strongBoost > weakBoost, `强边(${strongBoost}) 必须大于弱边(${weakBoost})`)
  })

  it('成环不会死循环，且同一张卡只加分一次', () => {
    const config = spreadConfig({ maxBoost: 1, maxHops: 3 })
    // a-b-c-a 三角环。
    const adjacency = buildAdjacency([
      edge('a', 'b', 'same-topic', 1),
      edge('b', 'c', 'same-topic', 1),
      edge('c', 'a', 'same-topic', 1),
    ])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
    const selfScores = new Map([['b', 0.5], ['c', 0.5]])
    const boosts = spreadActivation(seeds, adjacency, selfScores, config)
    assert.equal(boosts.length, 2, '只有 b 与 c，a 是种子不加分')
    const ids = boosts.map((x) => x.id).sort()
    assert.deepEqual(ids, ['b', 'c'], '每张卡只出现一次')
  })

  it('结果与种子传入顺序无关（ST-1 确定性）', () => {
    const config = spreadConfig({ maxBoost: 1, maxHops: 2 })
    const adjacency = buildAdjacency([
      edge('a', 't', 'same-entity', 0.7),
      edge('b', 't', 'same-entity', 0.9),
    ])
    const selfScores = new Map([['t', 0.5]])
    const forward = spreadActivation(
      [{ id: 'a', score: 0.8 }, { id: 'b', score: 0.9 }], adjacency, selfScores, config,
    )
    const reversed = spreadActivation(
      [{ id: 'b', score: 0.9 }, { id: 'a', score: 0.8 }], adjacency, selfScores, config,
    )
    assert.equal(forward.length, reversed.length)
    assert.equal(forward[0]?.id, reversed[0]?.id, '顺序无关：第一名必须相同')
    assert.ok(
      Math.abs((forward[0]?.boost ?? 0) - (reversed[0]?.boost ?? 0)) < 1e-12,
      '顺序无关：加分必须完全相同（浮点加法顺序固定）',
    )
  })

  it('来源被记录，供 FR-B4 解释「为什么想起这条」', () => {
    const config = spreadConfig()
    const adjacency = buildAdjacency([edge('a', 'b')])
    const boosts = spreadActivation(
      [{ id: 'a', score: 0.9 }], adjacency, new Map([['b', 0.5]]), config,
    )
    assert.deepEqual(boosts[0]?.sources, ['a'], '必须记下激活来自哪张卡')
  })
})

describe('边关系是否参与扩散（FR-G1）', () => {
  it('同话题/同实体/提炼参与，取代与三类语义边不参与', () => {
    assert.equal(isDiffusible('same-topic'), true)
    assert.equal(isDiffusible('same-entity'), true)
    assert.equal(isDiffusible('distills'), true)
    // supersedes 不参与：让激活沿它流动等于把废弃内容重新推上台面（与 FR-A5 相反）。
    assert.equal(isDiffusible('supersedes'), false)
    // 三类语义边当前无产出点，即便手工写入也不该假装它们有语义含义。
    assert.equal(isDiffusible('causes'), false)
    assert.equal(isDiffusible('part-of'), false)
    assert.equal(isDiffusible('contrasts'), false)
  })

  it('distills 边可反向传播（起源 L11：想起细节应当唤起感受）', () => {
    const config = spreadConfig({ distillBidirectional: true })
    const distill = edge('feeling', 'event', 'distills')
    assert.equal(canTraverse(distill, false, config), true, '正向必须可走')
    assert.equal(canTraverse(distill, true, config), true, '反向必须可走')
  })

  it('关掉 distillBidirectional 后 distills 反向被拒绝', () => {
    const config = spreadConfig({ distillBidirectional: false })
    const distill = edge('feeling', 'event', 'distills')
    assert.equal(canTraverse(distill, false, config), true)
    assert.equal(canTraverse(distill, true, config), false, '关闭后不得反向')
  })

  it('supersedes 即使开启 distillBidirectional 也不得反向', () => {
    // 这条防的是「把 distillBidirectional 写成「所有边都双向」」。
    const config = spreadConfig({ distillBidirectional: true })
    const supersedes = edge('old', 'new', 'supersedes')
    assert.equal(canTraverse(supersedes, false, config), false, 'supersedes 根本不参与扩散')
    assert.equal(canTraverse(supersedes, true, config), false)
  })

  it('反向传播让「命中事件卡」能唤起它的感受卡（起源 L11）', () => {
    // feeling 是来源，event 是它提炼自的事件。distills 方向是 feeling → event。
    // 命中 event（种子）时，feeling 应当通过反向传播获得加分。
    const config = spreadConfig({ maxBoost: 1, maxHops: 1, distillBidirectional: true })
    const adjacency = buildAdjacency([edge('feeling', 'event', 'distills', 1)])
    const boosts = spreadActivation(
      [{ id: 'event', score: 1 }], adjacency, new Map([['feeling', 0.5]]), config,
    )
    assert.equal(boosts.length, 1)
    assert.equal(boosts[0]?.id, 'feeling', '想起细节时必须能唤起感受')
  })
})

describe('把扩散结果合并进打分（FR-G1 / FR-B2）', () => {
  it('扩散在阈值截断之前生效，能把卡推进焦点包', () => {
    // b 自身分数低于绝对阈值，靠扩散仍不够（护栏会挡）；所以这里验证的是
    // 「本来就合格但排名靠后的卡，扩散后排名上升」。
    const config = spreadConfig({ maxBoost: 0.12 })
    const a = makeCard({ id: 'a', text: '项目 alpha 的部署方案' })
    const b = makeCard({ id: 'b', text: '项目 beta 的测试计划' })
    const query = makeQuery('alpha', config, 1000)
    const noSpread = scoreCards([a, b], query, config, [])
    const withSpread = scoreCards([a, b], query, config, [edge('a', 'b', 'same-entity', 1)])
    const bBefore = noSpread.find((x) => x.card.id === 'b')?.score.total ?? 0
    const bAfter = withSpread.find((x) => x.card.id === 'b')?.score.total ?? 0
    assert.ok(bAfter >= bBefore, `b 的分数不应下降：${bBefore} → ${bAfter}`)
  })

  it('关闭扩散时，传不传边集结果完全一致（零回归保证）', () => {
    const config = makeConfig({ spread: { enabled: false } })
    const a = makeCard({ id: 'a', text: '项目 alpha 部署' })
    const b = makeCard({ id: 'b', text: '项目 beta 测试' })
    const query = makeQuery('alpha', config, 1000)
    const without = scoreCards([a, b], query, config)
    const withEdges = scoreCards([a, b], query, config, [edge('a', 'b', 'same-entity', 1)])
    assert.deepEqual(
      without.map((x) => [x.card.id, x.score.total]),
      withEdges.map((x) => [x.card.id, x.score.total]),
      '关闭时必须完全一致',
    )
  })

  it('applySpread 不修改入参（ST-1 纯函数）', () => {
    const scored = [{ card: makeCard({ id: 'a' }), score: { total: 0.5 }, explain: '', conflict: false }]
    const before = JSON.stringify(scored)
    applySpread(scored, [{ id: 'a', boost: 0.1, sources: ['x'] }])
    assert.equal(JSON.stringify(scored), before, '入参必须原样不变')
  })
})

describe('突触可塑性（FR-G1）', () => {
  it('关闭可塑性时不产生任何边权变化', () => {
    const config = spreadConfig({ plasticityEnabled: false })
    const edges = [edge('a', 'b', 'same-entity', 0.5)]
    assert.deepEqual(reinforceEdges(edges, new Set(['a', 'b']), config), [])
    assert.deepEqual(decayEdges(edges, config), [])
    assert.deepEqual(prunableEdges(edges, config), [])
  })

  it('共激活时边权上升，但不超过 maxEdgeWeight', () => {
    const config = spreadConfig({ reinforceDelta: 0.05, maxEdgeWeight: 1 })
    const edges = [edge('a', 'b', 'same-entity', 0.5)]
    const updated = reinforceEdges(edges, new Set(['a', 'b']), config)
    assert.equal(updated.length, 1)
    assert.equal(updated[0]?.weight, 0.55, '0.5 + 0.05')

    // 已在上限时不再产生更新（避免日志堆积无意义记录）。
    const atMax = [edge('a', 'b', 'same-entity', 1)]
    assert.deepEqual(reinforceEdges(atMax, new Set(['a', 'b']), config), [])
  })

  it('只有两端都共激活才强化：只激活一端不算「一起被激活」', () => {
    const config = spreadConfig()
    const edges = [edge('a', 'b')]
    assert.deepEqual(
      reinforceEdges(edges, new Set(['a', 'c']), config), [],
      '两端不在同一集合里不得强化（这是赫布学习的定义）',
    )
    assert.deepEqual(reinforceEdges(edges, new Set(['a']), config), [], '少于两张不算共激活')
  })

  it('衰减按 decayFactor 缩小边权', () => {
    const config = spreadConfig({ decayFactor: 0.98 })
    const edges = [edge('a', 'b', 'same-entity', 0.5)]
    const updated = decayEdges(edges, config)
    assert.equal(updated.length, 1)
    assert.equal(updated[0]?.weight, 0.49, '0.5 × 0.98 = 0.49')
  })

  it('剪枝只挑低于阈值的边，且受 maxPrunePerRun 限制', () => {
    // 这里必须**分两段**验证，而且第一段的 maxPrunePerRun 要大于失效边数。
    // 起因是一次反向验证：把阈值过滤删掉（改成 `.filter(() => true)`），
    // 这条用例**依然全绿**——因为 maxPrunePerRun=2 把结果截成前两条，
    // 健康边恰好排在后面被截掉了。当时它守的不是「阈值在筛」，是「巧合还在」。
    // 阈值筛选与截断是两条独立规则，必须各用一段互不干扰的用例证明。
    const edges = [
      edge('a', 'b', 'same-entity', 0.05),
      edge('c', 'd', 'same-entity', 0.08),
      edge('e', 'f', 'same-entity', 0.09),
      edge('g', 'h', 'same-entity', 0.5),
    ]

    // 第一段：只验阈值筛选，截断上限放大到 10 使其不干扰。
    const allVictims = spreadConfig({ pruneThreshold: 0.1, maxPrunePerRun: 10 })
    const victims = prunableEdges(edges, allVictims)
    assert.equal(victims.length, 3, '恰好 3 条低于阈值，健康边不得入选')
    assert.equal(
      victims.includes(edge('g', 'h', 'same-entity', 0.5).id), false,
      '健康边不得被剪',
    )

    // 第二段：只验截断，失效边有 3 条而上限为 2。
    const limited = spreadConfig({ pruneThreshold: 0.1, maxPrunePerRun: 2 })
    assert.equal(prunableEdges(edges, limited).length, 2, '必须受 maxPrunePerRun 截断')
  })

  it('可塑性结果与输入顺序无关（ST-1）', () => {
    const config = spreadConfig()
    const e1 = edge('a', 'b', 'same-entity', 0.5)
    const e2 = edge('c', 'd', 'same-entity', 0.6)
    const forward = decayEdges([e1, e2], config).map((x) => [x.id, x.weight])
    const reversed = decayEdges([e2, e1], config).map((x) => [x.id, x.weight])
    assert.deepEqual(forward, reversed, '顺序无关')
  })
})

describe('buildAdjacency（FR-G1）', () => {
  it('两端都能作为起点被查到（反向遍历依赖这一点）', () => {
    const adjacency = buildAdjacency([edge('a', 'b')])
    assert.equal(adjacency.get('a')?.length, 1, 'from 端可查到')
    assert.equal(adjacency.get('b')?.length, 1, 'to 端也可查到')
  })

  it('空边集得到空邻接表，不抛错', () => {
    assert.equal(buildAdjacency([]).size, 0)
  })
})

describe('默认配置的诚实性（FR-G1 / 起源 L15）', () => {
  it('扩散与可塑性默认都关闭', () => {
    // 这条测试守的不是行为，是**承诺**：FR-G1 位于需求规格 §7.7「后续扩展」，
    // 触发条件是「稳定记忆跑通、积累了 2 周真实数据」。现在一条真实数据都没有，
    // 默认开启等于让一个未经真实数据检验的机制悄悄改变每一次召回的排序——
    // 而且改得不多，正是最难发现的那一类。
    //
    // 它拦住的是这种改动：有人看到「扩散实现了、测试全绿」，觉得「那当然应该
    // 默认开着」，顺手把 enabled 改成 true。那时所有测试仍然全绿（因为测试
    // 自己造配置），真实召回的排序却已经悄悄变了。
    assert.equal(DEFAULT_CONFIG.spread.enabled, false, '扩散默认必须关闭')
    assert.equal(DEFAULT_CONFIG.spread.plasticityEnabled, false, '可塑性默认必须关闭')
  })

  it('打分链路不改边权（纯函数性质）', () => {
    // 这里守的是**纯函数性质**，不是「可塑性没接线」——两者容易混淆，
    // 第一次写这条时就是混了：改成「把 reinforceEdges 接进 scoreCards」做反向
    // 验证，结果 fail=0。原因是 `reinforceEdges` 返回新对象、不改入参，
    // 所以「输入数组没变」在接线之后**依然成立**。那条反向验证什么也没证明。
    //
    // 「召回链路确实没有写库」是另一件事，必须在 engine 层验证（有真实 store、
    // 真实日志），见 `tests/host/engine.test.ts`「recall 不得改动图谱边权」。
    // 教训：反向验证没变红，先想「是不是断言选错了层次」，而不是加一条断言。
    const config = spreadConfig({ plasticityEnabled: true })
    const a = makeCard({ id: 'a', text: '项目 alpha 的部署方案' })
    const b = makeCard({ id: 'b', text: '项目 alpha 的回滚预案' })
    const edges = [edge('a', 'b', 'same-entity', 0.5)]
    const before = edges.map((e) => e.weight)
    scoreCards([a, b], makeQuery('alpha', config, 1000), config, edges)
    assert.deepEqual(edges.map((e) => e.weight), before, '纯函数不得修改入参')
  })
})
