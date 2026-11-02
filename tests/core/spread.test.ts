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
  isSymmetricRelation, prunableEdges, reinforceEdges, spreadActivation,
} from '../../src/core/spread.ts'
import type { SpreadSeed } from '../../src/core/spread.ts'
import { scoreCards } from '../../src/core/scoring.ts'
import { makeQuery } from '../../src/core/scoring.ts'
import { EDGE_RELATIONS, type MemoryEdge } from '../../src/core/types.ts'

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

    // 前提：a 必须是唯一够格当种子的卡（否则下面的断言守不住种子规则）。
    const maxScore = Math.max(...noSpread.map((x) => x.score.total))
    assert.equal(total(noSpread, 'a'), maxScore, '前提：a 是本轮最高分')
    assert.ok(
      total(noSpread, 'b') < maxScore * config.spread.seedRatio,
      '前提：b 必须够不到种子门槛，才可能是扩散的受益者',
    )

    assert.ok(
      total(withSpread, 'b') > total(noSpread, 'b'),
      `b 的分数必须严格上升：${total(noSpread, 'b')} → ${total(withSpread, 'b')}`,
    )
    assert.ok(
      total(withSpread, 'c') > total(noSpread, 'c'),
      `c 的分数必须严格上升：${total(noSpread, 'c')} → ${total(withSpread, 'c')}`,
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
