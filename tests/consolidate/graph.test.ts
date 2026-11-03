/**
 * 图谱连边单测。
 *
 * 对应需求：起源第 4 条「建立记忆图谱，且跨层次关联」、FR-C1（重建索引/连边）、
 * FR-A7（边可丢弃重建）、ST-1（确定性）、ST-2（幂等）。
 *
 * @module tests/consolidate/graph.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildEdges, entityOverlap } from '../../src/consolidate/graph.ts'
import { buildEdgeId } from '../../src/core/types.ts'
import { jaccard, tokenSet } from '../../src/core/text.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

const T0 = 1_700_000_000_000

describe('entityOverlap 实体重合度', () => {
  it('共享同一实体时为 1', () => {
    const a = makeCard({ id: 'a', entities: ['src/a.ts'] })
    const b = makeCard({ id: 'b', entities: ['src/a.ts'] })
    assert.equal(entityOverlap(a, b), 1)
  })

  it('无共享实体时为 0', () => {
    const a = makeCard({ id: 'a', entities: ['src/a.ts'] })
    const b = makeCard({ id: 'b', entities: ['src/b.ts'] })
    assert.equal(entityOverlap(a, b), 0)
  })

  it('部分共享时落在 0..1 之间', () => {
    const a = makeCard({ id: 'a', entities: ['src/a.ts', 'src/b.ts'] })
    const b = makeCard({ id: 'b', entities: ['src/a.ts', 'src/c.ts'] })
    const overlap = entityOverlap(a, b)
    assert.ok(overlap > 0 && overlap < 1)
  })

  it('任一卡无实体时为 0', () => {
    const a = makeCard({ id: 'a', entities: ['src/a.ts'] })
    const b = makeCard({ id: 'b', entities: [] })
    assert.equal(entityOverlap(a, b), 0)
  })

  it('大小写不敏感', () => {
    const a = makeCard({ id: 'a', entities: ['Src/A.ts'] })
    const b = makeCard({ id: 'b', entities: ['src/a.ts'] })
    assert.equal(entityOverlap(a, b), 1)
  })
})

describe('buildEdges 连边', () => {
  it('共享实体的两张卡之间建立 same-entity 边', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署脚本在 build.sh', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', text: 'build.sh 需要加权限', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    const edges = buildEdges(cards, config, T0)
    const sameEntity = edges.filter((edge) => edge.relation === 'same-entity')
    assert.equal(sameEntity.length, 1)
    assert.equal(sameEntity[0]?.from, 'a')
    assert.equal(sameEntity[0]?.to, 'b')
  })

  it('话题相似的卡之间建立 same-topic 边', () => {
    // 这条测试原先写的是 `dedup.relatedSimilarity: 0.3`——但那个参数已经不再
    // 被连边读取（缺陷二十四：它同时被冲突判定反向共用）。留着会让这条测试
    // **绿在错误的原因上**：它以为自己在验 relatedSimilarity，其实验的是
    // graph.topicFloor。改成显式给 graph 参数，测试才由规则决定。
    const config = makeConfig({ graph: { topicFloor: 0.1, topicNeighbors: 3 } })
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线自动化方案', createdAt: T0 + DAY_MS }),
    ]
    const edges = buildEdges(cards, config, T0)
    assert.ok(edges.some((edge) => edge.relation === 'same-topic'))
  })

  it('same-topic 边不再读取 dedup.relatedSimilarity（拆参数后才可能分开调）', () => {
    // 反向断言：把 relatedSimilarity 拉到极端（1.0），若连边还在读它，
    // 就一条 same-topic 边都产不出来。这条守的是「参数真的拆开了」。
    const config = makeConfig({
      dedup: { relatedSimilarity: 1, duplicateSimilarity: 0.99 },
      graph: { topicFloor: 0.1, topicNeighbors: 3 },
    })
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线自动化方案', createdAt: T0 + DAY_MS }),
    ]
    const edges = buildEdges(cards, config, T0)
    assert.ok(
      edges.some((edge) => edge.relation === 'same-topic'),
      'relatedSimilarity 调到 1 后仍应有 same-topic 边——否则说明连边还在读它',
    )
  })

  it('topicNeighbors 是硬上限：每个端点最多连出 K 条 same-topic 边', () => {
    // 这条守 P8「耗时可控」：边数上界必须是 n×K，与语料规模无关。
    // 若 K 不生效，O(n²) 会让万级记忆直接超时。
    const config = makeConfig({ graph: { topicFloor: 0.01, topicNeighbors: 2 } })
    const cards = [
      makeCard({ id: 'a', text: '记忆图谱跨层次关联扩散激活', createdAt: T0 }),
      makeCard({ id: 'b', text: '记忆图谱跨层次关联扩散激活方案', createdAt: T0 + 1 }),
      makeCard({ id: 'c', text: '记忆图谱跨层次关联扩散激活实现', createdAt: T0 + 2 }),
      makeCard({ id: 'd', text: '记忆图谱跨层次关联扩散激活验证', createdAt: T0 + 3 }),
    ]
    const edges = buildEdges(cards, config, T0).filter((edge) => edge.relation === 'same-topic')
    assert.ok(edges.length > 0, '前提：这组卡必须真的连出边，否则后面的断言是空的')
    // 断言选在「总边数 ≤ n×K」上是**没牙的**：k-NN 非对称，实际边数
    // 常常远低于上界（实测 K=2 时 5 条，上界 8），取消 K 后也只涨到 6 条，
    // 上界断言照样绿。真正被 K 限制的是**每张卡选了几个邻居**。
    // 因此必须按「每个 from 出度 ≤ K」断言——那是 K 直接作用的那一层。
    const outDegree = new Map<string, number>()
    for (const edge of edges) outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1)
    for (const [id, count] of outDegree) {
      assert.ok(
        count <= config.graph.topicNeighbors,
        `卡 ${id} 连出了 ${count} 条 same-topic 边，超过 topicNeighbors=${config.graph.topicNeighbors}`,
      )
    }
    // 同时守住「上界真的被用满」——若 K 完全不起作用，出度会明显更多。
    assert.equal(
      Math.max(...outDegree.values()),
      config.graph.topicNeighbors,
      '这组卡应当至少有一张用满 K 个邻居，否则这条测试没测到上限',
    )
  })

  it('topicNeighbors = 0 时完全不产 same-topic 边（可关断）', () => {
    const config = makeConfig({ graph: { topicFloor: 0.01, topicNeighbors: 0 } })
    const cards = [
      makeCard({ id: 'a', text: '记忆图谱跨层次关联', createdAt: T0 }),
      makeCard({ id: 'b', text: '记忆图谱跨层次关联方案', createdAt: T0 + 1 }),
    ]
    const edges = buildEdges(cards, config, T0)
    assert.equal(edges.filter((edge) => edge.relation === 'same-topic').length, 0)
  })

  it('相似度低于 topicFloor 的一律不连边（宁可孤立也不乱连）', () => {
    // 这条守的是「下限真的生效」。没有它，把 floor 判断删掉也不会有任何
    // 测试变红——反向验证时这条确实漏掉了，所以补在这里。
    //
    // 用例设计要点：两张卡必须有**微弱的真实相似度**（共享少量 bigram），
    // 否则相似度是 0，任何正 floor 都拦得住，测试就没测到「floor 这个数值」，
    // 只测到了「0 < floor」。第一版就踩了这个坑：对照组的 floor=0.01
    // 依然连不上边，断言直接红了。
    const cards = [
      makeCard({ id: 'a', text: '部署流水线要加缓存', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署流水线在凌晨跑', createdAt: T0 + 1 }),
    ]
    const similarity = jaccard(tokenSet(cards[0]!.normalized), tokenSet(cards[1]!.normalized))
    // 前提一：必须真的有一点相似（否则测的不是 floor 的值）。
    assert.ok(similarity > 0, `前提：两卡必须有微弱相似度，实际 ${similarity}`)
    const config = makeConfig({ graph: { topicFloor: 0.9, topicNeighbors: 3 } })
    // 前提二：必须真的低于 floor。
    assert.ok(
      similarity < config.graph.topicFloor,
      `前提：两卡相似度 ${similarity} 必须低于 floor ${config.graph.topicFloor}`,
    )
    const edges = buildEdges(cards, config, T0)
    assert.equal(
      edges.filter((edge) => edge.relation === 'same-topic').length,
      0,
      '低于 floor 的卡对不应连边',
    )
    // 对照：把 floor 降到相似度之下，同一对必须连边。
    // 没有这个对照，上面的断言可能只是「这对卡永远连不上」的另一种说法。
    const loose = makeConfig({ graph: { topicFloor: 0.01, topicNeighbors: 3 } })
    assert.ok(
      buildEdges(cards, loose, T0).some((edge) => edge.relation === 'same-topic'),
      '对照：floor 降到 0.01 后同一对必须连边，否则上面的断言是空的',
    )
  })

  it('相似度达到 duplicateSimilarity 的不再留 same-topic 边（交给合并）', () => {
    const config = makeConfig({ dedup: { duplicateSimilarity: 0.9 }, graph: { topicFloor: 0.1, topicNeighbors: 3 } })
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
    ]
    // 前提断言：两张卡必须真的达到 duplicateSimilarity，否则「没有边」
    // 可能只是因为它们根本不相似——那样这条测试就没验到上界逻辑。
    const similarity = jaccard(tokenSet(cards[0]!.normalized), tokenSet(cards[1]!.normalized))
    assert.ok(
      similarity >= config.dedup.duplicateSimilarity,
      `前提：两卡相似度 ${similarity} 必须 ≥ duplicateSimilarity ${config.dedup.duplicateSimilarity}`,
    )
    const edges = buildEdges(cards, config, T0)
    assert.equal(edges.filter((edge) => edge.relation === 'same-topic').length, 0)
  })

  it('单张卡不产生边', () => {
    assert.deepEqual(buildEdges([makeCard({ id: 'a' })], makeConfig(), T0), [])
  })

  it('空数组不产生边', () => {
    assert.deepEqual(buildEdges([], makeConfig(), T0), [])
  })

  it('已归档的卡不连边', () => {
    const cards = [
      makeCard({ id: 'a', entities: ['build.sh'], status: 'active', createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], status: 'archived', createdAt: T0 + DAY_MS }),
    ]
    assert.deepEqual(buildEdges(cards, makeConfig(), T0), [])
  })

  it('已被合并的卡不连边（避免指向幽灵节点）', () => {
    const cards = [
      makeCard({ id: 'a', entities: ['build.sh'], mergedInto: 'x', createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    assert.deepEqual(buildEdges(cards, makeConfig(), T0), [])
  })

  it('边 id 幂等：重复调用得到同样的 id（ST-2）', () => {
    const cards = [
      makeCard({ id: 'a', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    const first = buildEdges(cards, makeConfig(), T0).map((edge) => edge.id)
    const second = buildEdges(cards, makeConfig(), T0).map((edge) => edge.id)
    assert.deepEqual(first, second)
  })

  it('输入顺序不影响边集合（ST-1）', () => {
    const a = makeCard({ id: 'a', entities: ['build.sh'], createdAt: T0 })
    const b = makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS })
    const forward = buildEdges([a, b], makeConfig(), T0).map((edge) => edge.id).sort()
    const backward = buildEdges([b, a], makeConfig(), T0).map((edge) => edge.id).sort()
    assert.deepEqual(forward, backward)
  })

  it('同一对卡既有实体关联又有话题关联时两条边都保留', () => {
    const config = makeConfig({ dedup: { relatedSimilarity: 0.3, duplicateSimilarity: 0.99 } })
    const cards = [
      makeCard({ id: 'a', text: '数据库迁移用 Alembic', entities: ['alembic'], createdAt: T0 }),
      makeCard({ id: 'b', text: '数据库迁移用 Alembic 更好', entities: ['alembic'], createdAt: T0 + DAY_MS }),
    ]
    const edges = buildEdges(cards, config, T0)
    const relations = new Set(edges.map((edge) => edge.relation))
    assert.ok(relations.has('same-entity'))
    assert.ok(relations.has('same-topic'))
  })

  it('边权落在 0..1 且精度为 0.01', () => {
    const cards = [
      makeCard({ id: 'a', entities: ['build.sh', 'deploy.sh'], createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    for (const edge of buildEdges(cards, makeConfig(), T0)) {
      assert.ok(edge.weight >= 0 && edge.weight <= 1)
      assert.equal(edge.weight, Math.round(edge.weight * 100) / 100)
    }
  })

  it('边的 createdAt 为传入的 now', () => {
    const cards = [
      makeCard({ id: 'a', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    const at = T0 + 10 * DAY_MS
    for (const edge of buildEdges(cards, makeConfig(), at)) assert.equal(edge.createdAt, at)
  })

  it('不产生自环', () => {
    const cards = [
      makeCard({ id: 'a', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    for (const edge of buildEdges(cards, makeConfig(), T0)) {
      assert.notEqual(edge.from, edge.to)
    }
  })

  it('三张卡共享同一实体时两两连边', () => {
    const cards = [
      makeCard({ id: 'a', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
      makeCard({ id: 'c', entities: ['build.sh'], createdAt: T0 + 2 * DAY_MS }),
    ]
    const edges = buildEdges(cards, makeConfig(), T0).filter((edge) => edge.relation === 'same-entity')
    assert.equal(edges.length, 3)
  })
})

/**
 * 统计每张卡在 `same-entity` 边上的**度数**（入度 + 出度）。
 *
 * 必须双向计数：配置名 `entityNeighbors` 承诺的是「每张卡最多连几条边」，
 * 而用户看到的度数是入度 + 出度。只统计 `from` 会漏掉「被很多人选中」
 * 的那一半，正是单向限制会出错的地方。
 *
 * @param edges - 边数组（已按关系过滤）。
 * @returns 卡 id → 度数。
 */
function entityDegrees(edges: readonly { from: string; to: string }[]): Map<string, number> {
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  return degree
}

describe('same-entity 边的度数上限（P2-9）', () => {
  it('entityNeighbors 是硬上限：每张卡的 entity 度数 ≤ K，且边数远小于全量 C(N,2)', () => {
    // 这条守 P8「耗时可控」。加这个上限之前 `same-entity` 是全量两两连边：
    // 一个共享高频实体的簇会产出 C(N,2) 条边，实测生产 5000 卡 → 122500 条
    // entity 边、3621 ms。
    const n = 6
    const cards = Array.from({ length: n }, (_, index) => makeCard({
      id: `c${index}`,
      entities: ['proj/同一实体'],
      createdAt: T0 + index * DAY_MS,
    }))
    const full = (n * (n - 1)) / 2
    const config = makeConfig({ graph: { topicFloor: 0.08, topicNeighbors: 3, entityNeighbors: 2 } })
    const edges = buildEdges(cards, config, T0).filter((edge) => edge.relation === 'same-entity')

    // **前提断言**：这组 fixture 在不设上限时确实会产出超过上限的边数。
    // 没有它，测试可能在「本来就没那么多边」的情况下假绿——那正是本仓库
    // 反复吃过亏的「绿在错误的原因上」。
    const uncapped = buildEdges(cards, makeConfig({ graph: { entityNeighbors: 100 } }), T0)
      .filter((edge) => edge.relation === 'same-entity')
    assert.equal(uncapped.length, full, `前提：不设上限时必须连满 C(${n},2)=${full} 条边`)
    assert.ok(uncapped.length > config.graph.entityNeighbors * n / 2, '前提：全量边数必须超过上限')

    // 断言选在「每张卡的度数」上，那是 K 直接作用的那一层。
    // 只断言「总边数 ≤ n×K/2」是**没牙的**：K 完全失效时也可能因为
    // 别的分支少连边而照样绿。
    const degree = entityDegrees(edges)
    for (const card of cards) {
      const count = degree.get(card.id) ?? 0
      assert.ok(
        count <= config.graph.entityNeighbors,
        `卡 ${card.id} 的 entity 度数为 ${count}，超过 entityNeighbors=${config.graph.entityNeighbors}`,
      )
    }
    // 同时守住「上限真的被用满」——若 K 不起作用，度数会明显更多。
    assert.equal(
      Math.max(...degree.values()),
      config.graph.entityNeighbors,
      '这组卡应当至少有一张用满 K 个邻居，否则这条测试没测到上限',
    )
    // 边数必须真的降下来：双向约束下上界是 n×K/2。
    assert.ok(
      edges.length <= (n * config.graph.entityNeighbors) / 2,
      `边数 ${edges.length} 超过 n×K/2=${(n * config.graph.entityNeighbors) / 2}`,
    )
    assert.ok(edges.length < full, `边数 ${edges.length} 必须小于全量 ${full}，否则上限没生效`)
  })

  it('上限是双向的：被大量卡指向的枢纽卡度数也必须 ≤ K', () => {
    // 上面那条全对称簇**测不出单向限制**：贪心恰好让每张卡度数均衡，
    // 只检查 `from` 也照样 ≤ K（实测单向变异时那条仍绿）。
    // 要让它有牙，必须造**不对称**结构：一张枢纽卡 z 与 6 张叶子卡各共享
    // 一个不同实体，于是 6 条候选边全部是「叶子 → z」。
    //
    // 排序后 `from` 恒为叶子、`to` 恒为 z：只检查 `from` 时 6 条边全建，
    // z 的度数 = 6 ≫ K = 2。**这正是「配置名承诺每张卡最多连几条边」
    // 与「只限出度」之间的差别**。
    const k = 2
    const hubEntities = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5']
    const cards = [
      // 叶子 id 用 a 开头、枢纽用 z，保证排序后 from = 叶子
      ...hubEntities.map((entity, index) => makeCard({
        id: `a${index}`,
        entities: [entity],
        createdAt: T0 + index * DAY_MS,
      })),
      makeCard({ id: 'z', entities: hubEntities, createdAt: T0 + 10 * DAY_MS }),
    ]
    const config = makeConfig({ graph: { topicFloor: 0.08, topicNeighbors: 3, entityNeighbors: k } })
    const edges = buildEdges(cards, config, T0).filter((edge) => edge.relation === 'same-entity')

    // 前提一：这组 fixture 在不设上限时会连满 6 条，且枢纽度数会到 6。
    const uncapped = buildEdges(cards, makeConfig({ graph: { entityNeighbors: 100 } }), T0)
      .filter((edge) => edge.relation === 'same-entity')
    assert.equal(uncapped.length, hubEntities.length, '前提：不设上限时 6 张叶子各连一条')
    const uncappedDegree = entityDegrees(uncapped)
    assert.equal(uncappedDegree.get('z'), hubEntities.length, '前提：不设上限时枢纽度数应为 6')
    assert.ok(
      (uncappedDegree.get('z') ?? 0) > k,
      `前提：枢纽度数 ${uncappedDegree.get('z')} 必须超过上限 ${k}，否则测不到双向限制`,
    )
    // 前提二：方向必须真的是「叶子 → 枢纽」，否则测的是出度那一侧。
    for (const edge of uncapped) {
      assert.equal(edge.from.startsWith('a'), true, `前提：from 必须是叶子，实际 ${edge.from}`)
      assert.equal(edge.to, 'z', `前提：to 必须是枢纽，实际 ${edge.to}`)
    }

    const degree = entityDegrees(edges)
    assert.ok(
      (degree.get('z') ?? 0) <= k,
      `枢纽卡 z 的度数 ${degree.get('z')} 超过 entityNeighbors=${k}——单向限制只挡住了出度`,
    )
    for (const [id, count] of degree) {
      assert.ok(count <= k, `卡 ${id} 的度数 ${count} 超过 entityNeighbors=${k}`)
    }
    assert.ok(edges.length <= (cards.length * k) / 2, `边数 ${edges.length} 超过双向约束的上界`)
  })

  it('默认 entityNeighbors=8 在小规模语料上不改变行为，只在密集簇上生效', () => {
    // 这条守「默认值不改变现有行为」：3 张卡共享一个实体时度数是 2，
    // 远低于 8，所以两两连边照旧（与上面那条老用例同一 fixture，互为哨兵）。
    const small = [
      makeCard({ id: 'a', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
      makeCard({ id: 'c', entities: ['build.sh'], createdAt: T0 + 2 * DAY_MS }),
    ]
    assert.equal(makeConfig().graph.entityNeighbors, 8, '前提：默认值必须是 8')
    assert.equal(
      buildEdges(small, makeConfig(), T0).filter((edge) => edge.relation === 'same-entity').length,
      3,
      '3 张卡的度数只有 2，默认上限 8 不该砍掉任何一条边',
    )
    // 对照：同一个上限在**密集簇**上必须真的生效，否则「只在密集簇上生效」
    // 这句话的后半截就没有证据。12 张卡全量是 66 条，上限 8 下最多 48 条。
    const dense = Array.from({ length: 12 }, (_, index) => makeCard({
      id: `d${String(index).padStart(2, '0')}`,
      entities: ['proj/密集'],
      createdAt: T0 + index * DAY_MS,
    }))
    const denseEdges = buildEdges(dense, makeConfig(), T0).filter((edge) => edge.relation === 'same-entity')
    const full = (12 * 11) / 2
    assert.ok(denseEdges.length < full, `密集簇必须被砍：${denseEdges.length} 应小于 ${full}`)
    for (const [id, count] of entityDegrees(denseEdges)) {
      assert.ok(count <= 8, `卡 ${id} 的 entity 度数 ${count} 超过默认上限 8`)
    }
  })

  it('默认 8 下边集合不变，但数组顺序确实变了（把这条诚实边界钉成断言）', () => {
    // 这条守的是**注释里那句话**：「边集合不变 ≠ 边数组逐位不变」。
    //
    // 为什么要测：改法从「按实体桶顺序产出」变成「全局候选排序后贪心」，
    // 顺序必然改变。如果只在注释里写「顺序变了但无影响」，那是无法被证伪的
    // 说法——将来有人把顺序改回去、或改成别的顺序，注释会继续替实现撒谎。
    // 把它写成断言，顺序这件事就有了唯一真相源。
    //
    // **fixture 设计要点（第一版这里栽过）**：必须让「实体桶的插入顺序」与
    // 「(from,to) 字典序」**相反**，否则两种排法结果相同，断言就成了装饰。
    // 第一版用权重不同的实体对，权重项自己就决定了顺序，删掉次级键照样绿
    // （反向验证实测只红了另一条，这条没红——它当时没牙）。
    //
    // 这一版：两组**同权**（各 1 个实体 ⇒ 权重恒为 1），但池顺序是 c,d,a,b
    // （靠 createdAt 控制），于是实体桶 'q' 先于 'p' 被处理、候选对按
    // (c,d)、(a,b) 插入；而排序键要求 (a,b) 在前。
    const cards = [
      makeCard({ id: 'c', entities: ['q'], createdAt: T0 }),
      makeCard({ id: 'd', entities: ['q'], createdAt: T0 + DAY_MS }),
      makeCard({ id: 'a', entities: ['p'], createdAt: T0 + 2 * DAY_MS }),
      makeCard({ id: 'b', entities: ['p'], createdAt: T0 + 3 * DAY_MS }),
    ]
    const edges = buildEdges(cards, makeConfig(), T0).filter((edge) => edge.relation === 'same-entity')

    // 前提一：必须恰好 2 条边、且度数都是 1（远低于 8）⇒ 上限一条都没砍，
    // 这条测的是纯顺序，不是上限。
    assert.equal(edges.length, 2, '前提：应当恰好 2 条边，且一条都没被上限砍掉')
    assert.ok([...entityDegrees(edges).values()].every((count) => count === 1), '前提：每张卡度数都是 1')
    // 前提二：两条边必须**同权**，否则权重项自己就决定了顺序，测不到次级键。
    assert.equal(new Set(edges.map((edge) => edge.weight)).size, 1, '前提：两条边必须同权')
    // 前提三：池顺序必须是 c,d,a,b（与 (from,to) 字典序相反），否则没判别力。
    assert.deepEqual(
      [...cards].sort((x, y) => x.createdAt - y.createdAt).map((card) => card.id),
      ['c', 'd', 'a', 'b'],
      '前提：池顺序必须与 (from,to) 字典序相反',
    )

    // 判据：同权时按 (from,to) 升序 ⇒ a-b 必须在 c-d 之前，
    // 尽管 c-d 的候选对先被插入。缺次级键时会得到 ['c-d', 'a-b']。
    assert.deepEqual(
      edges.map((edge) => `${edge.from}-${edge.to}`),
      ['a-b', 'c-d'],
      '实体边数组必须按 (权重降序, from 升序, to 升序) 排列',
    )
    // 配对断言：证明「顺序变了」的同时**集合没变**——只有顺序断言、
    // 没有集合断言的话，「顺序对了但边被砍了」也能绿。
    assert.deepEqual(
      edges.map((edge) => edge.id).sort(),
      [
        buildEdgeId('a', 'b', 'same-entity'),
        buildEdgeId('c', 'd', 'same-entity'),
      ].sort(),
      '边集合必须恰好是这两条（上限一条都没砍）',
    )
  })

  it('输入顺序不影响边数组（含 id 顺序），同权对也要逐位相同（ST-1）', () => {
    // 这条守的是**排序键写对没写对**。用例设计要点：
    // 7 张卡共享同一个实体、每张只有 1 个实体 ⇒ 所有候选对的权重都是
    // `1/(1+1−1) = 1`，**全部同权**；K=2 让上限真的砍掉 21−7=14 条候选，
    // 于是「留下哪 7 条」完全由排序键决定。若排序键缺了 (from,to) 次级项，
    // 同权对的取舍就会依赖数组顺序。
    const n = 7
    const cards = Array.from({ length: n }, (_, index) => makeCard({
      id: `s${index}`,
      entities: ['proj/同权'],
      createdAt: T0 + index * DAY_MS,
    }))
    const config = makeConfig({ graph: { topicFloor: 0.08, topicNeighbors: 3, entityNeighbors: 2 } })
    const reference = buildEdges(cards, config, T0)
    const entityEdges = reference.filter((edge) => edge.relation === 'same-entity')
    // 前提一：上限必须真的砍掉东西，否则「同权对的取舍」这个问题根本不存在，
    // 打乱顺序也必然一致，测试就是空的。
    assert.ok(entityEdges.length > 0, '前提：必须真的连出边')
    assert.ok(
      entityEdges.length < (n * (n - 1)) / 2,
      `前提：必须真的砍掉候选（实得 ${entityEdges.length}，全量 ${(n * (n - 1)) / 2}）`,
    )
    // 前提二：权重必须真的全部相同，否则测的不是「同权取舍」。
    assert.equal(new Set(entityEdges.map((edge) => edge.weight)).size, 1, '前提：候选对必须全部同权')

    // 打乱传入顺序：逆序、轮转、以及一次交错。
    const permutations: (typeof cards)[] = [
      [...cards].reverse(),
      [...cards.slice(3), ...cards.slice(0, 3)],
      cards.filter((_, index) => index % 2 === 1).concat(cards.filter((_, index) => index % 2 === 0)),
    ]
    for (const [index, permuted] of permutations.entries()) {
      // 逐位比较**整个边数组**（含 id、from/to、权重、顺序），不是排序后的集合。
      // 排序后再比会掩盖「顺序不稳定」这一类失败。
      assert.deepEqual(
        buildEdges(permuted, config, T0),
        reference,
        `第 ${index + 1} 种输入顺序产出的边数组必须与参考逐位相同`,
      )
    }
  })

  it('同权时按 (from, to) 升序取舍（排序键的第二项真的生效）', () => {
    // 这条是「删掉次级排序键」的判据，比单纯打乱输入顺序更硬。
    //
    // 为什么打乱输入不够：`buildEdges` 开头会把 pool 按 `(createdAt, id)` 归一化，
    // 所以「插入顺序」在任何输入排列下都相同 ⇒ 只按权重排序（同权保持插入序）
    // 也能通过打乱测试。那是**等价变异**，测不出问题。
    //
    // 要让它有牙，必须让 **pool 顺序 ≠ id 顺序**：给卡片的 `createdAt` 逆向赋值，
    // 于是实体桶里的持有者顺序是 `e,d,c,b,a`，插入序与字典序相反。
    // 此时若排序键缺了 (from,to)，贪心会从 (e,d) 开始取，产出完全不同的边集。
    const ids = ['a', 'b', 'c', 'd', 'e']
    const cards = ids.map((id, index) => makeCard({
      id,
      entities: ['proj/逆序'],
      // 逆向 createdAt ⇒ pool 顺序为 e,d,c,b,a
      createdAt: T0 + (ids.length - 1 - index) * DAY_MS,
    }))
    const config = makeConfig({ graph: { topicFloor: 0.08, topicNeighbors: 3, entityNeighbors: 2 } })
    const edges = buildEdges(cards, config, T0).filter((edge) => edge.relation === 'same-entity')

    // 前提一：pool 顺序必须真的与 id 顺序相反，否则这条测试退化成打乱测试。
    const poolOrder = [...cards]
      .sort((x, y) => (x.createdAt !== y.createdAt ? x.createdAt - y.createdAt : (x.id < y.id ? -1 : 1)))
      .map((card) => card.id)
    assert.deepEqual(poolOrder, ['e', 'd', 'c', 'b', 'a'], `前提：pool 顺序必须逆序，实际 ${poolOrder.join(',')}`)
    // 前提二：必须全部同权，否则权重项就决定了顺序，测不到次级键。
    assert.equal(new Set(edges.map((edge) => edge.weight)).size, 1, '前提：候选对必须全部同权')
    // 前提三：上限必须真的砍掉候选。
    assert.ok(edges.length > 0 && edges.length < (ids.length * (ids.length - 1)) / 2, '前提：必须真的砍掉候选')

    // 判据：同权时按 (from, to) 升序取舍。
    //
    // 注意 `from`/`to` 的**方向**来自实体桶的插入顺序（`holders` 的先后），
    // 不是字典序规范化过的——`same-entity` 是无向关系，方向只影响 id 与
    // 数组顺序，不影响语义。所以 pool 逆序时，字典序最小的卡 `a` 会以
    // `to` 的身份出现（`from` 是更早进入桶的 `b`）。
    // 期望值就是「按 (from,to) 升序贪心 K=2」的唯一结果：
    // (b,a) → (c,a) → (c,b) → 跳过 → (e,d)，共 4 条。
    // 若排序键缺了 (from,to)，贪心会按桶的插入序从 (e,d) 开始，
    // 得到 (e,d)(e,c)(d,c) 三条——数量与内容都不同。
    assert.deepEqual(
      edges.map((edge) => `${edge.from}${edge.to}`),
      ['ba', 'ca', 'cb', 'ed'],
      '同权时必须按 (from,to) 升序取舍，而不是按实体桶的插入顺序',
    )
  })

  it('entityNeighbors = 0 时完全不产 same-entity 边，但 same-topic 边照常产出', () => {
    // 0 表示「不建 entity 边」（语义与 topicNeighbors = 0 一致），
    // 同时它还是性能短路：跳过整个 O(n²) 的实体候选计算。
    const config = makeConfig({
      graph: { topicFloor: 0.01, topicNeighbors: 3, entityNeighbors: 0 },
      dedup: { relatedSimilarity: 0.3, duplicateSimilarity: 0.99 },
    })
    const cards = [
      makeCard({ id: 'a', text: '数据库迁移用 Alembic', entities: ['alembic'], createdAt: T0 }),
      makeCard({ id: 'b', text: '数据库迁移用 Alembic 更好', entities: ['alembic'], createdAt: T0 + DAY_MS }),
    ]
    // 前提：同一对卡在默认配置下**两种边都有**，否则「0 关掉 entity」
    // 可能只是因为这对卡本来就不共享实体。
    const both = buildEdges(cards, makeConfig({ graph: { topicFloor: 0.01 } }), T0)
    assert.ok(both.some((edge) => edge.relation === 'same-entity'), '前提：默认配置下应有 same-entity 边')
    assert.ok(both.some((edge) => edge.relation === 'same-topic'), '前提：默认配置下应有 same-topic 边')

    const edges = buildEdges(cards, config, T0)
    assert.equal(
      edges.filter((edge) => edge.relation === 'same-entity').length,
      0,
      'entityNeighbors = 0 必须一条 entity 边都不产',
    )
    // 证明短路只关掉 entity 这一路：topic 那一路照常。
    assert.ok(
      edges.some((edge) => edge.relation === 'same-topic'),
      'same-topic 边必须照常产出——否则说明短路误伤了另一条通路',
    )
  })
})
