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
