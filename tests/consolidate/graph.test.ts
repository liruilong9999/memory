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
    const config = makeConfig({ dedup: { relatedSimilarity: 0.3, duplicateSimilarity: 0.95 } })
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线自动化方案', createdAt: T0 + DAY_MS }),
    ]
    const edges = buildEdges(cards, config, T0)
    assert.ok(edges.some((edge) => edge.relation === 'same-topic'))
  })

  it('相似度达到 duplicateSimilarity 的不再留 same-topic 边（交给合并）', () => {
    const config = makeConfig({ dedup: { relatedSimilarity: 0.3, duplicateSimilarity: 0.9 } })
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
    ]
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
