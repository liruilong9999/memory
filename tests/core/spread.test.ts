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
  isSymmetricRelation, nextDecayedWeight, prunableEdges, reinforceEdges, spreadActivation,
} from '../../src/core/spread.ts'
import type { SpreadSeed } from '../../src/core/spread.ts'
import { buildFocusPack, renderFocusPack, scoreCards } from '../../src/core/scoring.ts'
import { makeQuery } from '../../src/core/scoring.ts'
import { renderFocusPackExplain } from '../../src/core/render.ts'
import { EDGE_RELATIONS, type MemoryEdge, type TimeState } from '../../src/core/types.ts'

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
      mode: 'on',
      hopDecay: 0.5,
      maxHops: 2,
      maxBoost: 0.12,
      minSelfScoreRatio: 1,
      seedRatio: 0.85,
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
    const config = makeConfig({ spread: { mode: 'off' } })
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

  it('护栏：自身相关分低于绝对阈值的卡，扩散不给它加分', () => {
    // `selfScores` 里装的是**相关分量**（`relevance`），不是总分——这一点是
    // 修缺陷二十六时改的，改之前装的是 `total`，而 `total` 有 0.48 权重与
    // 查询无关，于是「无关但新鲜」的卡也能过这道护栏，护栏恒真。
    // 现在护栏与被护栏的量在同一把尺子上（都是 `relevance`），判据才有意义。
    const config = spreadConfig()
    const adjacency = buildAdjacency([edge('a', 'b')])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 0.9 }]
    // 取一个严格低于门槛的值，不写死数字——阈值调整后这条不会变成假绿。
    const belowFloor = config.recall.absoluteThreshold * config.spread.minSelfScoreRatio - 0.001
    assert.ok(belowFloor >= 0, '前提：门槛必须留有可用下界')
    const boosts = spreadActivation(seeds, adjacency, new Map([['b', belowFloor]]), config)
    assert.deepEqual(boosts, [], '不合格的卡不能靠邻居混进来（否则阈值语义被稀释）')
  })

  it('护栏的边界：恰好等于门槛的卡可以通过', () => {
    // minSelfScoreRatio = 1 时，门槛 = absoluteThreshold × 1。
    // 恰好等于门槛必须通过 —— 防止将来有人把 `>=` 写成 `>`。
    const config = spreadConfig()
    const adjacency = buildAdjacency([edge('a', 'b')])
    const seeds: SpreadSeed[] = [{ id: 'a', score: 0.9 }]
    const floor = config.recall.absoluteThreshold * config.spread.minSelfScoreRatio
    const boosts = spreadActivation(seeds, adjacency, new Map([['b', floor]]), config)
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

  // 以下三条守的是**截断留下的是哪几张**。上面那条只断言数量，
  // 不管留的是 b/c 还是 b/d，所以它对「排序键是否正确」完全没有约束力——
  // 而这正是缺陷所在：旧的排序键是截平后的 `boost`，多张卡撞在 `maxBoost`
  // 上时比较恒等，排序退化成按 id 哈希，与强弱无关。
  describe('maxAffected 截断必须按强弱取舍，不能退化成按 id 哈希', () => {
    it('raw 更强的卡优先留下，即使截平后的 boost 完全相同', () => {
      // 构造：a 以不同边权连到 b/c/d，三者 raw 不同，但都超过 maxBoost。
      // 旧实现下三者 boost 全 = maxBoost，比较恒等 → 按 id 排序，
      // 留下的可能是任意两张；新实现必须留下 raw 最大的 d、c。
      //
      // **id 顺序故意与强弱顺序相反**（d 最强、b 最弱）：若按 id 排序会留下
      // b、c，与期望的 c、d 不同。第一版测试把 id 写成 b/c/d 对应强/中/弱，
      // 于是「按 id 排序」恰好也得到 b、c，反向验证时 M1 变异不红——
      // 那条测试绿在巧合上，测不出排序键。
      const config = spreadConfig({ maxAffected: 2, maxBoost: 0.1, hopDecay: 1, maxHops: 1 })
      const adjacency = buildAdjacency([
        edge('a', 'd', 'same-entity', 1),    // raw = 1.0 × 1.0 × 1 = 1.0  → 最强
        edge('a', 'c', 'same-entity', 0.8),  // raw = 0.8              → 次强
        edge('a', 'b', 'same-entity', 0.6),  // raw = 0.6              → 最弱
      ])
      const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
      const selfScores = new Map([['b', 0.5], ['c', 0.5], ['d', 0.5]])
      const boosts = spreadActivation(seeds, adjacency, selfScores, config)
      // 前提断言：三者确实都撞在 maxBoost 上（否则本条测不到「截平后无区分度」）
      assert.equal(boosts.length, 2, '前提：必须发生截断')
      assert.ok(
        boosts.every((x) => x.boost === config.spread.maxBoost),
        '前提：三张卡的 boost 都被截平到 maxBoost，才谈得上「排序键失效」',
      )
      const kept = boosts.map((x) => x.id).sort()
      assert.deepEqual(kept, ['c', 'd'], '必须留下 raw 最强的 c、d，而不是按 id 哈希挑 b、c')
    })

    it('raw 相同时按自身分取舍：留自身更强的，不留 id 更小的', () => {
      // 构造 raw 完全相同的三张卡（同一条边权、同一跳），自身分不同。
      // 这是真实数据里最常见的形态：同一批 weight=1.0 的边一跳传出。
      const config = spreadConfig({ maxAffected: 2, maxBoost: 0.1, hopDecay: 1, maxHops: 1 })
      const adjacency = buildAdjacency([
        edge('a', 'x1', 'same-entity', 1),
        edge('a', 'x2', 'same-entity', 1),
        edge('a', 'x3', 'same-entity', 1),
      ])
      const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
      // id 字典序是 x1 < x2 < x3，但自身分最高的是 x3、x2。
      // 旧实现按 id 排序会留下 x1、x2 —— 恰好丢掉自身最强的 x3。
      const selfScores = new Map([['x1', 0.20], ['x2', 0.35], ['x3', 0.50]])
      const boosts = spreadActivation(seeds, adjacency, selfScores, config)
      const kept = boosts.map((x) => x.id).sort()
      assert.deepEqual(kept, ['x2', 'x3'], 'raw 相同时必须按自身分留，而不是按 id 留')
      assert.ok(!kept.includes('x1'), '自身分最低的 x1 必须被淘汰')
    })

    it('全同时按 id 升序兜底：这是 ST-1 确定性的最后一道保险', () => {
      // 全部 raw、自身分都相同，只剩 id 这一个区分量。
      //
      // ## 这条测试的注释曾经撒过谎（实测抓到，已改）
      //
      // 第一版写的是「边传入顺序不同也必须得到相同结果」，并断言
      // `reversed === first`。反向验证时把兜底键改成 `return 0`，
      // 这条用例确实变红了 —— 但我以为红在第二句，实际红在最后那句
      // `deepEqual(first, ['p','q','r'])`。
      //
      // 直接跑最小复现证明：`buildAdjacency` 内部**已按 `edge.id` 排序**
      // （见其实现第一行 `const sorted = [...edges].sort(...)`），
      // 所以把入参边数组反转，建出来的邻接表逐键逐边完全相同。
      // 变异后正序、逆序结果都是 `q,p,t`，两结果**依然相等**。
      // 也就是说「输入容器顺序」这个场景在本函数里根本构造不出来，
      // 那句注释描述的是不存在的行为。
      //
      // 兜底键真正的作用就是**给全平局一个确定解**，所以断言必须直接写
      // 「留下的是 id 字典序最小的三个」，而不是绕道去比两次调用。
      const config = spreadConfig({ maxAffected: 3, maxBoost: 0.1, hopDecay: 1, maxHops: 1 })
      const edges = [
        edge('a', 'p', 'same-entity', 1),
        edge('a', 'q', 'same-entity', 1),
        edge('a', 'r', 'same-entity', 1),
        edge('a', 's', 'same-entity', 1),
        edge('a', 't', 'same-entity', 1),
      ]
      const seeds: SpreadSeed[] = [{ id: 'a', score: 1 }]
      const selfScores = new Map([['p', 0.5], ['q', 0.5], ['r', 0.5], ['s', 0.5], ['t', 0.5]])
      const kept = spreadActivation(seeds, buildAdjacency(edges), selfScores, config).map((x) => x.id)
      // 五张卡 raw 与自身分全部相同，只能靠 id 兜底。
      // 若兜底键缺失，V8 的稳定排序会保留 Map 插入顺序（即 `q,p,t,...`），
      // 与 id 升序不同 —— 这正是反向验证里能变红的那一处。
      assert.deepEqual(kept, ['p', 'q', 'r'], '全同时必须按 id 升序兜底，不能依赖 Map 插入顺序')
      // 同时确认五张卡确实全部同分（否则上面的断言可能只是碰巧）
      const all = spreadActivation(
        seeds, buildAdjacency(edges), selfScores, spreadConfig({ maxAffected: 5, maxBoost: 0.1, hopDecay: 1, maxHops: 1 }),
      )
      assert.equal(new Set(all.map((x) => x.boost)).size, 1, '前提：五张卡的 boost 必须完全相同')
    })
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

  it('对称关系（same-entity / same-topic）两个方向都必须可走', () => {
    // 这条守的是一个真实缺陷：`same-entity` 语义上对称（A 与 B 共享实体
    // ⇔ B 与 A 共享实体），但 `graph.ts` 建边时必须写一个具体方向，那个方向
    // 来自 `pool` 排序，与「谁是本轮种子」无关。原先只允许沿出边走，
    // 于是激活有一半概率传不出去。
    //
    // 实测（20 轮语料 / 21 张卡 / 10 条 same-entity 边）：查询「PostgreSQL」
    // 唯一种子是日摘要卡，而 4 条相关边全是「普通卡 → 摘要卡」，摘要卡无出边
    // ⇒ 扩散 0 条；把同样这些边反向立刻变成 4 条。21 个查询只有 4 个生效。
    const config = spreadConfig({ distillBidirectional: false })
    for (const relation of ['same-entity', 'same-topic'] as const) {
      const e = edge('a', 'b', relation)
      assert.equal(canTraverse(e, false, config), true, `${relation} 正向必须可走`)
      assert.equal(
        canTraverse(e, true, config), true,
        `${relation} 反向也必须可走——它是对称关系，方向由建边顺序随机决定，` +
        `只走正向会让扩散效果变成运气`,
      )
    }
  })

  it('isSymmetricRelation 的分类覆盖全部关系类型，不留漏判', () => {
    // 断言「哪些关系对称」这条知识没有漏项：新增关系时必须显式决定它算不算
    // 对称，而不是让它默认落进「单向」里静默出错。
    const symmetric = EDGE_RELATIONS.filter((r) => isSymmetricRelation(r))
    assert.deepEqual([...symmetric].sort(), ['same-entity', 'same-topic'])
    // 非对称的那几个必须明确不是对称——尤其 supersedes / distills，
    // 它们的反向语义是错的（「旧取代新」「事件提炼出感受」都说不通）。
    for (const relation of ['supersedes', 'distills', 'causes', 'part-of', 'contrasts'] as const) {
      assert.equal(isSymmetricRelation(relation), false, `${relation} 不是对称关系`)
    }
  })

  it('same-entity 两个方向的传播都成立（种子是哪一端都走得通）', () => {
    // 端到端语义：无论种子是普通卡还是摘要卡，激活都要能走过去。
    // 这条同时覆盖两个方向，所以「边方向写反」也不会让它变绿。
    const config = spreadConfig({ maxBoost: 1, maxHops: 1, distillBidirectional: false })
    const adjacency = buildAdjacency([edge('summary', 'detail', 'same-entity', 1)])
    // 种子是 detail，边方向是 summary → detail：必须反向才能到 summary。
    const fromDetail = spreadActivation(
      [{ id: 'detail', score: 1 }], adjacency, new Map([['summary', 0.5]]), config,
    )
    assert.equal(fromDetail.length, 1, '种子是普通卡时，摘要卡应被唤起')
    assert.equal(fromDetail[0]?.id, 'summary')
    // 反过来：种子是 summary，正向直达 detail。
    const fromSummary = spreadActivation(
      [{ id: 'summary', score: 1 }], adjacency, new Map([['detail', 0.5]]), config,
    )
    assert.equal(fromSummary.length, 1, '种子是摘要卡时，普通卡也应被唤起')
    assert.equal(fromSummary[0]?.id, 'detail')
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
  it('扩散真的把排名靠后的卡提了分（断言严格上升，不是「没下降」）', () => {
    // 这条测试曾经写的是 `assert.ok(bAfter >= bBefore)`，**等式成立也算通过**。
    // 而当时扩散在真实链路上恒为空（种子判据 0.18 低于所有卡的基础分下限，
    // 所有卡都是种子、种子不加分），所以 bAfter === bBefore，它一直绿着，
    // 却从没守过任何东西。反向验证把种子判据改坏，它也不红。
    //
    // 现在断言**严格上升**，并且同时断言「谁被加分」符合种子规则：
    // 只有过了 seedRatio 门槛的最高分卡当种子，其余卡才是受益者。
    //
    // ## 缺陷二十六之后：护栏的尺子换了，`c` 不再获得加分
    //
    // `selfScores` 从 `total` 换成了 `relevance`（见 `mergeSpread` 的注释）。
    // 于是 `c`（「无关的做饭记录」，relevance = 0）不再拿到扩散加分——
    // **这正是护栏终于有牙的证据**：它以前恒真，是因为 `total` 有 0.48
    // 权重与查询无关，一张无关卡也能拿 0.32，任何门槛都拦不住。
    //
    // 所以本用例现在守两件事，缺一不可：
    // ① 相关卡 b 必须**严格上升**（扩散确实在工作）；
    // ② 无关卡 c 必须**完全不变**（护栏确实在拦）。
    // 只守 ① 的话，把护栏整个删掉它也全绿。
    const config = spreadConfig({ maxBoost: 0.12, seedRatio: 0.85 })
    const a = makeCard({ id: 'a', text: 'Cordis 版本' })
    const b = makeCard({ id: 'b', text: 'Cordis' })
    const c = makeCard({ id: 'c', text: '无关的做饭记录' })
    const query = makeQuery('Cordis 版本', config, 1000)
    const noSpread = scoreCards([a, b, c], query, config, [])
    const withSpread = scoreCards([a, b, c], query, config, [
      edge('a', 'b', 'same-entity', 0.9),
      edge('a', 'c', 'same-entity', 0.9),
    ])
    const total = (list: typeof noSpread, id: string) =>
      list.find((x) => x.card.id === id)?.score.total ?? 0
    const relevance = (list: typeof noSpread, id: string) =>
      list.find((x) => x.card.id === id)?.score.relevance ?? 0

    // 前提：a 必须是唯一够格当种子的卡（否则下面的断言守不住种子规则）。
    const maxScore = Math.max(...noSpread.map((x) => x.score.total))
    assert.equal(total(noSpread, 'a'), maxScore, '前提：a 是本轮最高分')
    assert.ok(
      total(noSpread, 'b') < maxScore * config.spread.seedRatio,
      '前提：b 必须够不到种子门槛，才可能是扩散的受益者',
    )
    // 前提：b 的相关分必须过护栏下限，否则它也会被挡，① 就无从验证。
    assert.ok(
      relevance(noSpread, 'b') >= config.recall.absoluteThreshold * config.spread.minSelfScoreRatio,
      `前提：b 的相关分必须过扩散护栏，实际 ${relevance(noSpread, 'b')}`,
    )
    // 前提：c 必须真的无关（relevance = 0），否则 ② 测的不是护栏。
    assert.equal(relevance(noSpread, 'c'), 0, '前提：c 必须与查询零相关')

    assert.ok(
      total(withSpread, 'b') > total(noSpread, 'b'),
      `b 的分数必须严格上升：${total(noSpread, 'b')} → ${total(withSpread, 'b')}`,
    )
    // ② 护栏有牙：无关卡哪怕连着一条 weight=0.9 的边，也不许被加分。
    assert.equal(
      total(withSpread, 'c'), total(noSpread, 'c'),
      `无关卡 c 不得因扩散加分（否则「有个强邻居」就能把无关卡塞进焦点包，违反 FR-B2）。`
      + `实际 ${total(noSpread, 'c')} → ${total(withSpread, 'c')}`,
    )
    // 种子自己不因扩散加分（否则等于「命中自己还额外奖励」，重复计分）。
    assert.equal(
      total(withSpread, 'a'), total(noSpread, 'a'),
      '种子卡 a 不得因扩散加分',
    )
  })

  it('关闭扩散时，传不传边集结果完全一致（零回归保证）', () => {
    const config = makeConfig({ spread: { mode: 'off' } })
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

  it('衰减在任意权重上都不会停摆（缺陷二十：量化格比步长还粗）', () => {
    // 这条测试是**缺陷二十**的守卫，也是它为什么长期全绿的答案。
    //
    // 上面那条「衰减按 decayFactor 缩小边权」只走**一步**：`0.5 × 0.98 = 0.49`。
    // 一步跨了整整两格（0.01 粒度下），所以它绿得毫无问题。但衰减真正要
    // 发生的地方不是第一步，是**第二十步、第五百步**——而那里它早就停了。
    //
    // 旧实现 `Math.round(w * 0.98 * 100) / 100` 的每步衰减量是 `0.02 × w`。
    // 令它小于半格（0.005）得 `w ≤ 0.25`：**权重一旦掉到 0.25 以下，
    // 每步衰减都被四舍五入回原值，永久冻结**。实测 500 夜不变，
    // `prunableEdges` 一次都没触发——整个「遗忘」机制一行都没真正执行过。
    //
    // 只测一步的测试永远不会发现这件事，因为它测的那一步恰好不在停摆区。
    const config = spreadConfig({ decayFactor: 0.98 })

    // 覆盖停摆区（≤ 0.25）、停摆区上方、以及几乎不衰减的极端参数。
    for (const start of [0.9, 0.5, 0.3, 0.25, 0.24, 0.1, 0.05]) {
      let weight = start
      let nights = 0
      while (weight > 0 && nights < 1000) {
        const next = nextDecayedWeight(weight, config.spread.decayFactor)
        assert.ok(
          next < weight,
          `起点 ${start}：第 ${nights + 1} 夜权重 ${weight} 没有变弱（得到 ${next}）` +
          '——衰减一旦原地不动，剪枝永远不会触发，遗忘机制整体失效',
        )
        weight = next
        nights += 1
      }
      assert.equal(weight, 0, `起点 ${start}：必须在有限夜内衰减到 0，实际停在 ${weight}`)
    }

    // 停摆区的具体证据：0.25 在旧实现下是 25 个不动点之一，必须真的降。
    assert.equal(nextDecayedWeight(0.25, 0.98), 0.24, '0.25 是旧实现的不动点，必须降')
    assert.equal(nextDecayedWeight(0.24, 0.98), 0.23, '0.24 同样是不动点')

    // 比例衰减足够大时，必须走真实比例而不是「一格保底」——
    // 否则修缺陷二十会顺手把衰减速度锁死成一格，那是另一个静默错误。
    assert.equal(nextDecayedWeight(1, 0.5), 0.5, '大比例衰减必须走真实比例')
    assert.equal(nextDecayedWeight(0.8, 0.5), 0.4, '大比例衰减必须走真实比例')

    // 这个修法有一个**已知代价**，必须写出来而不是藏着：极慢的衰减系数
    // （如 0.999）本来意图是「几乎不衰减」，但为了不停摆，它被抬到了
    // 「每夜至少一格」，也就是比参数声明得更快。
    // 接受这个代价，是因为反过来（忠实于参数、允许停摆）会让「遗忘」
    // 变成一个有时会静默关闭的机制——那比「忘得快一点」坏得多。
    assert.equal(
      nextDecayedWeight(0.5, 0.999), 0.49,
      '慢衰减系数也必须真的降（代价：比参数声明的略快）',
    )
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
  it('扩散默认是影子模式，可塑性默认未启用', () => {
    // 这条测试守的不是行为，是**承诺**。
    //
    // FR-G1 位于需求规格 §7.7「后续扩展」，触发条件是「稳定记忆跑通、
    // 积累了 2 周真实数据」。现在一条真实数据都没有，所以：
    //   - 不能默认 `'on'`：那等于让一个未经检验的机制悄悄改变每一次召回的
    //     排序，而且改得不多，正是最难发现的那一类；
    //   - 也不能默认 `'off'`：关掉就永远拿不到「它到底会怎么改」的证据，
    //     而那份证据正是判断该不该打开它的唯一依据。关闭状态下的「没出问题」
    //     不能证明任何事——它压根没跑。
    // 所以默认 `'shadow'`：算出来、记下来、排序不动。
    //
    // 它拦住的是这两种改动：有人看到「扩散实现了、测试全绿」，顺手把 mode
    // 改成 `'on'`（所有测试仍绿，因为测试自己造配置，真实召回却已悄悄改变）；
    // 或者有人为了「绝对安全」把 mode 改成 `'off'`，于是影子观察永久为零，
    // 而没人会注意到「观测数据一直是空的」这件事本身是个问题。
    assert.equal(DEFAULT_CONFIG.spread.mode, 'shadow', '扩散默认必须是影子模式')
    assert.equal(DEFAULT_CONFIG.spread.plasticityEnabled, false, '可塑性默认必须关闭')
  })

  it('影子模式默认值能真的产出观察数据（不是空转）', () => {
    // 上面那条只断言了「默认值是 shadow」。默认值对，不代表**默认配置下
    // 影子观察真的会发生**。
    //
    // 这条测试的来历值得记下来：它第一次写的时候只放了两张**分数相同**的卡，
    // 于是两张都是种子、谁都不被加分，观察数为 0，测试红了。查下去才发现
    // 真正的问题比测试红严重得多——当时种子判据用的是 `absoluteThreshold`
    // （0.18），而打分有基础分下限（无关文本也有 0.33），0.18 永远拦不住
    // 任何卡，**所有卡都是种子，扩散在真实链路上恒为空**，31 条单测却全绿。
    //
    // 所以这条用例的构造必须让「有种子、也有非种子」同时成立：三张卡分三档，
    // 只有最高分那张过 seedRatio 门槛。
    const config = DEFAULT_CONFIG
    const now = 1000
    const cards = [
      makeCard({ id: 'a', text: 'Cordis 版本' }),
      makeCard({ id: 'b', text: 'Cordis' }),
      makeCard({ id: 'c', text: '无关的做饭记录' }),
    ]
    const edges = [
      makeEdge('a', 'b', 'same-entity', 0.9, now),
      makeEdge('a', 'c', 'same-entity', 0.9, now),
    ]
    const query = makeQuery('Cordis 版本', config, now)
    const result = scoreCards(cards, query, config, edges)
    const observed = result.filter((item) => item.shadowSpread !== undefined)
    assert.ok(observed.length > 0, '前提：默认配置下影子模式必须真的观察到扩散')
    // 观察到的卡，其实际总分必须与不传边时**逐位相同**——这是影子模式的定义。
    const withoutEdges = scoreCards(cards, query, config, [])
    for (const item of result) {
      const plain = withoutEdges.find((x) => x.card.id === item.card.id)
      assert.equal(item.score.total, plain?.score.total, `影子模式不得改动 ${item.card.id} 的实际总分`)
    }
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

describe('影子模式（SpreadMode = shadow）', () => {
  // 三张卡分三档：a 最高（唯一种子），b 次高（被 a 连，扩散的受益者），
  // c 最低且孤立。
  //
  // `maxBoost` 必须足够大，让 b 加分后**真的超过** c —— 否则影子模式观察到
  // 的排名永远不变，「actualRank vs hypotheticalRank」就永远看不出差异，
  // 那几条断言也就守不住任何东西（反向验证时确实一条都没红）。
  function shadowFixture(mode: MemoryConfig['spread']['mode']): {
    config: MemoryConfig
    cards: ReturnType<typeof makeCard>[]
    edges: MemoryEdge[]
    query: ReturnType<typeof makeQuery>
  } {
    const config = spreadConfig({ mode, maxBoost: 0.2 })
    const cards = [
      makeCard({ id: 'a', text: 'Cordis 版本' }),
      makeCard({ id: 'b', text: 'Cordis' }),
      makeCard({ id: 'c', text: 'Cordis 版本 3.2' }),
    ]
    const edges = [edge('a', 'b', 'same-entity', 1)]
    return { config, cards, edges, query: makeQuery('Cordis 版本', config, 1000) }
  }

  it('影子模式算出真实加分，但实际总分与不传边时逐位相同', () => {
    const { config, cards, edges, query } = shadowFixture('shadow')
    const observed = scoreCards(cards, query, config, edges)
    const plain = scoreCards(cards, query, config, [])
    // 前提：影子模式必须真的算出了东西，否则下面「总分不变」是空转。
    const withShadow = observed.filter((x) => x.shadowSpread !== undefined)
    assert.ok(withShadow.length > 0, '前提：影子模式必须产出观察值')
    for (const item of withShadow) {
      assert.ok(item.shadowSpread!.boost > 0, '观察到的加分必须为正')
      const p = plain.find((x) => x.card.id === item.card.id)
      assert.equal(
        item.score.total, p?.score.total,
        `影子模式不得改动实际总分（${item.card.id}）`,
      )
    }
  })

  it('影子模式不改变排序：实际顺序与不传边时完全一致', () => {
    const { config, cards, edges, query } = shadowFixture('shadow')
    const observed = scoreCards(cards, query, config, edges).map((x) => x.card.id)
    const plain = scoreCards(cards, query, config, []).map((x) => x.card.id)
    assert.deepEqual(observed, plain, '影子模式不得改变排序')
  })

  it('影子模式记录的 hypotheticalRank 与真实 on 模式的排名一致', () => {
    // 这是影子模式价值的核心：它观察到的「假如生效会怎样」必须是**真的**。
    // 若 hypotheticalRank 与实际 on 模式的排名不一致，攒下的证据全是假的，
    // 那么「攒够数据再决定是否打开」这条路就走不通。
    const shadow = shadowFixture('shadow')
    const on = shadowFixture('on')
    const shadowResult = scoreCards(shadow.cards, shadow.query, shadow.config, shadow.edges)
    const onResult = scoreCards(on.cards, on.query, on.config, on.edges)
    const onRank = new Map(onResult.map((x, i) => [x.card.id, i + 1]))
    for (const item of shadowResult) {
      if (item.shadowSpread === undefined) continue
      assert.equal(
        item.shadowSpread.hypotheticalRank, onRank.get(item.card.id),
        `${item.card.id} 的影子排名必须等于真实 on 模式的排名`,
      )
      const onTotal = onResult.find((x) => x.card.id === item.card.id)?.score.total ?? -1
      assert.equal(
        item.shadowSpread.hypotheticalTotal, onTotal,
        `${item.card.id} 的影子总分必须等于真实 on 模式的总分`,
      )
    }
  })

  it('影子模式记录 actualRank，且 actualRank 与 hypotheticalRank 可分离', () => {
    const { config, cards, edges, query } = shadowFixture('shadow')
    const result = scoreCards(cards, query, config, edges)
    const observed = result.filter((x) => x.shadowSpread !== undefined)
    assert.ok(observed.length > 0, '前提：必须有观察值')
    for (const item of observed) {
      const actualIndex = result.findIndex((x) => x.card.id === item.card.id)
      assert.equal(
        item.shadowSpread!.actualRank, actualIndex + 1,
        `${item.card.id} 的 actualRank 必须是它当前的真实位置（1-based）`,
      )
    }
  })

  it("关闭（off）时不产出任何观察值——没算就是没算，不能假装算过", () => {
    const { config, cards, edges, query } = shadowFixture('off')
    const result = scoreCards(cards, query, config, edges)
    assert.equal(
      result.filter((x) => x.shadowSpread !== undefined).length, 0,
      'off 模式下 shadowSpread 必须全部为 undefined',
    )
  })

  it("打开（on）时加分已折进总分，不再单独留观察值——避免两个真相来源", () => {
    const { config, cards, edges, query } = shadowFixture('on')
    const result = scoreCards(cards, query, config, edges)
    assert.equal(
      result.filter((x) => x.shadowSpread !== undefined).length, 0,
      'on 模式下 shadowSpread 必须全部为 undefined（加分已在 total 里）',
    )
    // 同时证明 on 模式确实改了分（否则上一条断言可能只是因为什么都没算）。
    const plain = scoreCards(cards, query, config, [])
    const changed = result.some((item) => {
      const p = plain.find((x) => x.card.id === item.card.id)
      return p !== undefined && item.score.total !== p.score.total
    })
    assert.ok(changed, '前提：on 模式必须真的改变了某些卡的总分')
  })

  it('影子模式不污染 explain——人读渲染不得看到未生效的加分', () => {
    // explain 会被 renderFocusPackExplain 打印给人和 CLI，
    // 若把 hypothetical 数值写进 explain，读的人会以为它已经生效了。
    //
    // 注意：explain 是**字符串数组**（每个维度一行），必须 deepEqual 逐行比，
    // 用 assert.equal 比的是数组引用，两个不同数组永远不相等——那条写法
    // 会让这条测试在正确实现上也失败（我第一版就写错了）。
    const { config, cards, edges, query } = shadowFixture('shadow')
    const withEdges = scoreCards(cards, query, config, edges)
    const plain = scoreCards(cards, query, config, [])
    for (const item of withEdges) {
      const p = plain.find((x) => x.card.id === item.card.id)
      assert.deepEqual(item.explain, p?.explain, `影子模式不得改动 ${item.card.id} 的 explain`)
    }
  })
})

describe('影子模式的排名预测必须与真实排序一致（tie-break 专项）', () => {
  // 上一条「hypotheticalRank 与 on 模式一致」的用例，fixture 里三张卡分数
  // **两两不同**，所以排序时根本走不到 tie-break 分支。把 tie-break 改成
  // id 降序，那条用例依然全绿——它没守住 tie-break。
  //
  // 这里专门造「两张被加分的卡同分」：a 是种子，b 和 c 都被 a 连、
  // 加同样的分，于是 hypotheticalTotal 完全相等。此时顺序只能由
  // tie-break（id 升序）决定，一旦 tie-break 写错，影子预测的排名
  // 就会与真实 on 模式的排名不一致——那份证据就废了。
  function tieFixture(mode: MemoryConfig['spread']['mode']): {
    config: MemoryConfig
    cards: ReturnType<typeof makeCard>[]
    edges: MemoryEdge[]
    query: ReturnType<typeof makeQuery>
  } {
    const config = spreadConfig({ mode, maxBoost: 0.2 })
    const cards = [
      makeCard({ id: 'a', text: 'Cordis 版本' }),
      makeCard({ id: 'b', text: 'Cordis' }),
      makeCard({ id: 'c', text: '版本' }),
    ]
    const edges = [
      edge('a', 'b', 'same-entity', 1),
      edge('a', 'c', 'same-entity', 1),
    ]
    return { config, cards, edges, query: makeQuery('Cordis 版本', config, 1000) }
  }

  it('同分时影子预测的排名与真实 on 模式完全一致', () => {
    const shadow = tieFixture('shadow')
    const on = tieFixture('on')
    const shadowResult = scoreCards(shadow.cards, shadow.query, shadow.config, shadow.edges)
    const onResult = scoreCards(on.cards, on.query, on.config, on.edges)

    // 前提：必须真的出现同分，否则 tie-break 不会被触发，这条用例就没意义。
    const boosted = shadowResult.filter((x) => x.shadowSpread !== undefined)
    assert.equal(boosted.length, 2, '前提：必须恰好两张卡被加分')
    assert.equal(
      boosted[0]?.shadowSpread?.hypotheticalTotal, boosted[1]?.shadowSpread?.hypotheticalTotal,
      '前提：两张被加分的卡必须同分，tie-break 才会被触发',
    )

    const onRank = new Map(onResult.map((x, i) => [x.card.id, i + 1]))
    for (const item of boosted) {
      assert.equal(
        item.shadowSpread!.hypotheticalRank, onRank.get(item.card.id),
        `${item.card.id} 同分时的影子排名必须等于真实 on 模式排名`,
      )
    }
    // 同分时 id 小的排前面（升序 tie-break）。
    assert.ok(
      (onRank.get('b') ?? 99) < (onRank.get('c') ?? 99),
      '同分时必须按 id 升序：b 应排在 c 之前',
    )
  })
})

describe('on 模式的 explain 必须自洽且能说出「因为想起了谁」（FR-B4）', () => {
  // ## 这一组守的是一个被实测抓出的真缺陷
  //
  // `explain` 由 `scoreCard` 生成，那时扩散**还没发生**（`mergeSpread` 在打分
  // 之后才跑）。`applySpread` 只改 `score.total`，不改 `explain`。于是 `on`
  // 模式下同一张卡在人读渲染里报出**两个互相矛盾的总分**：
  //
  //   总分 0.449        ← 头行取 score.total（已含 +0.12）
  //   语义相关 0.500 ... ← 五项加起来 = 0.329
  //   总分 0.329        ← 末行取 explain，是加分前的值
  //
  // 实测 5 张卡里 3 张如此，差额恰好等于 boost（0.1200）。
  // 比「少一行」更糟：少一行是漏了，**两行矛盾是自相矛盾**，
  // 读者只会认为系统算错了。FR-B4「可解释」的判据是能回答「为什么想起这条」，
  // 而这里给出的答案是错的。
  //
  // 注意 fixture **必须在本 describe 内定义**：上面几个 describe 里的
  // `shadowFixture` 是各自的局部函数，跨 describe 取不到（第一版就踩了这个，
  // 报 `ReferenceError: shadowFixture is not defined`）。

  /**
   * 三张卡 + 一条 a→b 边的最小扩散场景。
   *
   * @param mode - 扩散模式。
   * @returns 配置、卡片、边、查询。
   */
  function explainFixture(mode: MemoryConfig['spread']['mode']): {
    config: MemoryConfig
    cards: ReturnType<typeof makeCard>[]
    edges: MemoryEdge[]
    query: ReturnType<typeof makeQuery>
  } {
    const config = spreadConfig({ mode, maxBoost: 0.2 })
    const cards = [
      makeCard({ id: 'a', text: 'Cordis 版本' }),
      makeCard({ id: 'b', text: 'Cordis' }),
      makeCard({ id: 'c', text: 'Cordis 版本 3.2' }),
    ]
    const edges = [edge('a', 'b', 'same-entity', 1)]
    return { config, cards, edges, query: makeQuery('Cordis 版本', config, 1000) }
  }

  /**
   * 从 explain 里取末行总分。
   *
   * @param explain - 解释行数组。
   * @returns 末行声明的总分；末行不是总分时返回 undefined。
   */
  function tailTotal(explain: readonly string[]): number | undefined {
    const tail = explain[explain.length - 1]
    if (tail === undefined || !tail.startsWith('总分 ')) return undefined
    return Number.parseFloat(tail.slice('总分 '.length))
  }

  it('末行总分必须等于 score.total——同一张卡不得报出两个总分', () => {
    const { config, cards, edges, query } = explainFixture('on')
    const result = scoreCards(cards, query, config, edges)
    // 前提：必须真的有卡被加分，否则下面「两行一致」是空转。
    const boosted = result.filter((x) => x.explain.some((l) => l.includes('扩散加分')))
    assert.ok(boosted.length > 0, '前提：on 模式必须有卡被扩散加分')
    for (const item of boosted) {
      assert.equal(
        tailTotal(item.explain), Number.parseFloat(item.score.total.toFixed(3)),
        `${item.card.id} 的 explain 末行总分必须与 score.total 一致`
        + `（实际末行 ${String(tailTotal(item.explain))}，score.total ${item.score.total}）`,
      )
    }
  })

  it('explain 必须有一行说明扩散加分，不能只改总分不解释', () => {
    const { config, cards, edges, query } = explainFixture('on')
    const result = scoreCards(cards, query, config, edges)
    const boosted = result.filter((x) => x.explain.some((l) => l.includes('扩散加分')))
    assert.ok(boosted.length > 0, 'on 模式下被加分的卡必须有「扩散加分」行')
    // 没被加分的卡不该凭空多一行（否则「加分」和「没加分」在输出上不可区分）。
    for (const item of result) {
      const hasLine = item.explain.some((l) => l.includes('扩散加分'))
      if (hasLine) continue
      const plain = scoreCards([item.card], query, config, [])
        .find((x) => x.card.id === item.card.id)
      assert.deepEqual(
        item.explain, plain?.explain,
        `${item.card.id} 未被加分时 explain 不得被改动`,
      )
    }
  })

  it('explain 必须说出「因为想起了哪张卡」，不能只报数量', () => {
    // 用户要的是「类似神经的突触效果」。突触效果的可感知形态不只是
    // 「分数高了」，而是**能说出「因为想起 A，所以想起 B」**。
    // 只显示「来自 2 张关联卡」时，读者知道有来源却不知道是哪两张，
    // 扩散在观感上仍是「莫名加分」。
    const { config, cards, edges, query } = explainFixture('on')
    const result = scoreCards(cards, query, config, edges)
    const line = result.flatMap((x) => x.explain).find((l) => l.includes('扩散加分'))
    assert.ok(line !== undefined, '前提：必须有扩散加分行')
    assert.ok(
      line.includes('因为想起了'),
      `扩散加分行必须说出是哪张卡（实际：${line}）`,
    )
    // 必须真的带上来源卡的文本，而不是只有「因为想起了：」这个空壳。
    const seedText = cards.find((c) => c.id === 'a')?.text
    assert.ok(
      seedText !== undefined && line.includes(seedText.slice(0, 4)),
      `来源卡文本必须出现在解释里（实际：${line}）`,
    )
  })

  it('explainSourceChars 控制来源文本长度，0 退回只报数量', () => {
    const zero = explainFixture('on')
    const cfg = { ...zero.config, spread: { ...zero.config.spread, explainSourceChars: 0 } }
    const line = scoreCards(zero.cards, zero.query, cfg, zero.edges)
      .flatMap((x) => x.explain).find((l) => l.includes('扩散加分'))
    assert.ok(line !== undefined, '前提：必须有扩散加分行')
    assert.ok(
      !line.includes('因为想起了') && line.includes('张关联卡'),
      `explainSourceChars = 0 时必须退回只报数量（实际：${line}）`,
    )
  })

  it('扩散字段的可见性：on 有、shadow/off 没有——否则两个真相源会混', () => {
    // 这三个字段曾经**只在运行时挂上、类型里没声明**，
    // 于是没有任何消费方能读它，也就没有「因为想起了谁」那一行。
    // 这条从行为上钉住——on 必须有值，shadow/off 必须为 undefined。
    const on = explainFixture('on')
    const onResult = scoreCards(on.cards, on.query, on.config, on.edges)
    const boosted = onResult.filter((x) => (x.spreadBoost ?? 0) > 0)
    assert.ok(boosted.length > 0, '前提：on 模式必须有卡获得扩散加分')
    for (const item of boosted) {
      assert.ok(
        (item.spreadSources ?? []).length > 0,
        `${item.card.id} 有 spreadBoost 就必须有 spreadSources（否则只知道加了分、不知道为什么）`,
      )
    }

    for (const mode of ['shadow', 'off'] as const) {
      const f = explainFixture(mode)
      const result = scoreCards(f.cards, f.query, f.config, f.edges)
      for (const item of result) {
        assert.equal(
          item.spreadBoost, undefined,
          `${mode} 模式不得记 spreadBoost——它没生效，记了就是两个真相源`,
        )
        assert.equal(
          item.spreadSources, undefined,
          `${mode} 模式不得记 spreadSources`,
        )
      }
    }
  })

  it('影子模式不得出现「扩散加分」行——它没生效，写了就是撒谎', () => {
    // 与上一条配对：on 模式必须有这一行，shadow 模式必须没有。
    // 只有前者没有后者的话，「必须有」可能只是因为它被无条件加上了。
    const { config, cards, edges, query } = explainFixture('shadow')
    const result = scoreCards(cards, query, config, edges)
    for (const item of result) {
      assert.ok(
        !item.explain.some((l) => l.includes('扩散加分')),
        `影子模式不得在 explain 里出现「扩散加分」（${item.card.id}）`,
      )
    }
  })
})

describe('扩散解释只能进人读渲染，绝不能进注入上下文（起源 L17）', () => {
  // 起源 L17（无编号·上下文污染）：「上下文被无关信息污染」是本系统要解决的
  // 问题。给 explain 加「因为想起了哪张卡」是为了让人**看得见**突触效果，
  // 但这段文字一旦漏进注入文本，就等于拿 token 预算去污染模型上下文——
  // 而且它是给人看的，对模型毫无用处。
  //
  // 两条路径必须分清：
  //   注入路径 `renderFocusPack(pack, time)` → 进 systemPrompt.context()
  //   人读路径 `renderFocusPackExplain(pack, candidates)` → 进 /memory explain 与 CLI
  //
  // 这个文件此前只测了 `scoreCards` 的数学性质，没测过「注入文本里有什么」，
  // 所以「解释漏进上下文」这类回归它抓不到。

  /**
   * 三张卡 + 一条 a→b 边的最小扩散场景。
   *
   * 必须在本 describe 内定义：上一个 describe 的 `explainFixture`
   * 是局部函数，跨 describe 取不到。这个错我在同一个文件里
   * 犯了两次（第一次是 `shadowFixture`）。
   *
   * @param mode - 扩散模式。
   * @returns 配置、卡片、边、查询。
   */
  function leakFixture(mode: MemoryConfig['spread']['mode']): {
    config: MemoryConfig
    cards: ReturnType<typeof makeCard>[]
    edges: MemoryEdge[]
    query: ReturnType<typeof makeQuery>
  } {
    const config = spreadConfig({ mode, maxBoost: 0.2 })
    const cards = [
      makeCard({ id: 'a', text: 'Cordis 版本' }),
      makeCard({ id: 'b', text: 'Cordis' }),
      makeCard({ id: 'c', text: 'Cordis 版本 3.2' }),
    ]
    const edges = [edge('a', 'b', 'same-entity', 1)]
    return { config, cards, edges, query: makeQuery('Cordis 版本', config, 1000) }
  }

  /** 固定时间状态，避免时间维度让输出漂移。 */
  const time: TimeState = {
    now: 1000, timeZone: 'Asia/Shanghai', localDate: '1970-01-01',
    sinceLastSession: null, sinceLastTurn: null, sessionStartedAt: null, due: [],
  }

  it('注入文本不得出现「扩散」「因为想起了」「关联卡」', () => {
    const { config, cards, edges, query } = leakFixture('on')
    const scored = scoreCards(cards, query, config, edges)
    const pack = buildFocusPack(scored, query, config)
    // 前提：这一轮必须真的有卡被扩散加分，否则「没泄漏」是空转。
    assert.ok(
      pack.cards.some((c) => c.explain.some((l) => l.includes('扩散加分'))),
      '前提：焦点包里必须有被扩散加分的卡',
    )
    const injected = renderFocusPack(pack, time)
    for (const word of ['扩散', '因为想起了', '关联卡', '权重 1.000']) {
      assert.ok(
        !injected.includes(word),
        `注入文本不得包含「${word}」（会污染上下文，起源 L17）：\n${injected}`,
      )
    }
  })

  it('人读渲染必须有这段解释——否则它等于没算', () => {
    // 与上一条配对。只有「注入不得含」没有「人读必须有」的话，
    // 把解释整个删掉也能让上一条变绿。
    const { config, cards, edges, query } = leakFixture('on')
    const scored = scoreCards(cards, query, config, edges)
    const pack = buildFocusPack(scored, query, config)
    const human = renderFocusPackExplain(pack, scored.length)
    assert.ok(
      human.includes('因为想起了'),
      `人读渲染必须说出「因为想起了谁」，实际：\n${human}`,
    )
  })
})
