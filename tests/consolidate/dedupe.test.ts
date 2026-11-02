/**
 * 去重与合并单测。
 *
 * 对应需求：FR-C1（夜整理最小集：去重、合并）、FR-C4（库增长有界）、
 * FR-A5（修正记录可查）、ST-2（幂等）、ST-1（确定性）。
 *
 * @module tests/consolidate/dedupe.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  cardSimilarity, findDuplicateGroups, mergeGroup, sortByAge,
} from '../../src/consolidate/dedupe.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

const T0 = 1_700_000_000_000

describe('cardSimilarity 相似度', () => {
  it('完全相同的文本相似度为 1', () => {
    const a = makeCard({ id: 'a', text: '这个项目用 Qt5 开发' })
    const b = makeCard({ id: 'b', text: '这个项目用 Qt5 开发' })
    assert.equal(cardSimilarity(a, b), 1)
  })

  it('完全无关的文本相似度接近 0', () => {
    const a = makeCard({ id: 'a', text: '部署走 CI 流水线' })
    const b = makeCard({ id: 'b', text: '今天天气不错适合散步' })
    assert.ok(cardSimilarity(a, b) < 0.1)
  })

  it('相似度对称', () => {
    const a = makeCard({ id: 'a', text: '数据库迁移用 Alembic' })
    const b = makeCard({ id: 'b', text: '数据库迁移方案选 Alembic 而不是手写 SQL' })
    assert.equal(cardSimilarity(a, b), cardSimilarity(b, a))
  })

  it('normalized 为空时退回原文归一化', () => {
    const a = makeCard({ id: 'a', text: '部署走 CI', normalized: '' })
    const b = makeCard({ id: 'b', text: '部署走 CI', normalized: '' })
    assert.equal(cardSimilarity(a, b), 1)
  })

  it('可传入缓存复用词项集合', () => {
    const a = makeCard({ id: 'a', text: '部署走 CI 流水线' })
    const b = makeCard({ id: 'b', text: '部署走 CI 流水线' })
    const cache = new Map<string, Set<string>>()
    const first = cardSimilarity(a, b, cache)
    const second = cardSimilarity(a, b, cache)
    assert.equal(first, second)
    assert.equal(cache.size, 2)
  })
})

describe('sortByAge 稳定排序', () => {
  it('按创建时间升序', () => {
    const cards = [
      makeCard({ id: 'c', createdAt: T0 + 2 * DAY_MS }),
      makeCard({ id: 'a', createdAt: T0 }),
      makeCard({ id: 'b', createdAt: T0 + DAY_MS }),
    ]
    assert.deepEqual(sortByAge(cards).map((card) => card.id), ['a', 'b', 'c'])
  })

  it('同一时刻按 id 升序', () => {
    const cards = [
      makeCard({ id: 'z', createdAt: T0 }),
      makeCard({ id: 'a', createdAt: T0 }),
      makeCard({ id: 'm', createdAt: T0 }),
    ]
    assert.deepEqual(sortByAge(cards).map((card) => card.id), ['a', 'm', 'z'])
  })

  it('不修改入参', () => {
    const cards = [
      makeCard({ id: 'c', createdAt: T0 + DAY_MS }),
      makeCard({ id: 'a', createdAt: T0 }),
    ]
    const before = cards.map((card) => card.id)
    sortByAge(cards)
    assert.deepEqual(cards.map((card) => card.id), before)
  })

  it('同样输入两次排序结果一致（ST-1）', () => {
    const cards = [
      makeCard({ id: 'b', createdAt: T0 }),
      makeCard({ id: 'a', createdAt: T0 }),
      makeCard({ id: 'c', createdAt: T0 }),
    ]
    assert.deepEqual(sortByAge(cards).map((c) => c.id), sortByAge(cards).map((c) => c.id))
  })
})

describe('findDuplicateGroups 重复分组', () => {
  it('完全相同文本归为一组', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
    ]
    const groups = findDuplicateGroups(cards, config)
    assert.equal(groups.length, 1)
    assert.equal(groups[0]?.cards.length, 2)
  })

  it('组内成员按创建时间升序，最早的在前', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
    ]
    const groups = findDuplicateGroups(cards, config)
    assert.deepEqual(groups[0]?.cards.map((card) => card.id), ['a', 'b'])
  })

  it('无关文本不分组', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线' }),
      makeCard({ id: 'b', text: '今天天气不错适合散步' }),
    ]
    assert.deepEqual(findDuplicateGroups(cards, config), [])
  })

  it('单张卡不产生分组', () => {
    const config = makeConfig()
    assert.deepEqual(findDuplicateGroups([makeCard({ id: 'a', text: '部署走 CI' })], config), [])
  })

  it('空数组不产生分组', () => {
    assert.deepEqual(findDuplicateGroups([], makeConfig()), [])
  })

  it('已归档的卡不参与分组', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', status: 'active' }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', status: 'archived' }),
    ]
    assert.deepEqual(findDuplicateGroups(cards, config), [])
  })

  it('已被合并的卡不参与分组', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', mergedInto: 'x' }),
      makeCard({ id: 'b', text: '部署走 CI 流水线' }),
    ]
    assert.deepEqual(findDuplicateGroups(cards, config), [])
  })

  it('组内相似度记录最小值（保守口径）', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线' }),
      makeCard({ id: 'b', text: '部署走 CI 流水线' }),
    ]
    const groups = findDuplicateGroups(cards, config)
    assert.equal(groups[0]?.similarity, 1)
  })

  it('输入顺序不影响分组结果（ST-1）', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 })
    const b = makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS })
    const c = makeCard({ id: 'c', text: '数据库迁移用 Alembic', createdAt: T0 + 2 * DAY_MS })

    const forward = findDuplicateGroups([a, b, c], config)
    const backward = findDuplicateGroups([c, b, a], config)
    assert.deepEqual(
      forward.map((group) => group.cards.map((card) => card.id)),
      backward.map((group) => group.cards.map((card) => card.id)),
    )
  })

  it('阈值可配：调低阈值能把近似文本并入同组', () => {
    const strict = makeConfig({ dedup: { duplicateSimilarity: 0.99 } })
    const loose = makeConfig({ dedup: { duplicateSimilarity: 0.3 } })
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线自动化' }),
      makeCard({ id: 'b', text: '部署走 CI 流水线' }),
    ]
    assert.equal(findDuplicateGroups(cards, strict).length, 0)
    assert.equal(findDuplicateGroups(cards, loose).length, 1)
  })

  it('摘要卡不参与去重（否则每天一张日摘要会被合并成一张）', () => {
    const config = makeConfig()
    // 两天的日摘要文本只差日期，字面相似度极高——若参与去重必然被判重复。
    const day1 = makeCard({
      id: 's1', kind: 'summary', text: '2023-11-15：7 条记忆，主要涉及工作，关键词 摘要、压缩',
    })
    const day2 = makeCard({
      id: 's2', kind: 'summary', text: '2023-11-16：7 条记忆，主要涉及工作，关键词 摘要、压缩',
    })
    // 前提断言：这两张卡若参与去重，相似度确实超标——防止将来阈值改动
    // 让本用例变成「因为不够像所以不合并」，从而失去意义。
    assert.ok(
      cardSimilarity(day1, day2) >= config.dedup.duplicateSimilarity,
      `前提不成立：相似度 ${cardSimilarity(day1, day2)} 未达阈值 ${config.dedup.duplicateSimilarity}`,
    )
    assert.equal(
      findDuplicateGroups([day1, day2], config).length, 0,
      '摘要卡必须被排除在去重之外',
    )
  })

  it('摘要卡与事件卡之间也不做去重', () => {
    const config = makeConfig()
    const summary = makeCard({ id: 's1', kind: 'summary', text: '2023-11-15：7 条记忆，关键词 摘要、压缩' })
    const event = makeCard({ id: 'e1', kind: 'event', text: '2023-11-15：7 条记忆，关键词 摘要、压缩' })
    assert.equal(findDuplicateGroups([summary, event], config).length, 0)
  })
})

describe('mergeGroup 合并', () => {
  it('存活卡沿用最早那张的 id / source / createdAt', () => {
    const config = makeConfig()
    const early = makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 })
    const late = makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS })
    const merged = mergeGroup([late, early], config)
    assert.equal(merged.id, 'a')
    assert.equal(merged.createdAt, T0)
    assert.deepEqual(merged.source, early.source)
  })

  it('updatedAt 取最新', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, updatedAt: T0 })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, updatedAt: T0 + 3 * DAY_MS })
    assert.equal(mergeGroup([a, b], config).updatedAt, T0 + 3 * DAY_MS)
  })

  it('strength 取最大值，不因弱副本被拉低', () => {
    const config = makeConfig()
    const strong = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, strength: 0.9 })
    const weak = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, strength: 0.2 })
    assert.equal(mergeGroup([strong, weak], config).strength, 0.9)
  })

  it('emotional 取最大值（起源第 1 条：感受不被稀释）', () => {
    const config = makeConfig()
    const calm = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, emotional: 0.1 })
    const intense = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, emotional: 0.95 })
    assert.equal(mergeGroup([calm, intense], config).emotional, 0.95)
  })

  it('accessCount 求和', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, accessCount: 3 })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, accessCount: 5 })
    assert.equal(mergeGroup([a, b], config).accessCount, 8)
  })

  it('lastAccessAt 取最晚的非空值', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, lastAccessAt: T0 + DAY_MS })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0, lastAccessAt: null })
    assert.equal(mergeGroup([a, b], config).lastAccessAt, T0 + DAY_MS)
  })

  it('文本取最长的那条', () => {
    const config = makeConfig()
    const short = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })
    const long = makeCard({ id: 'b', text: '部署走 CI 流水线自动化方案', createdAt: T0 + DAY_MS })
    assert.equal(mergeGroup([short, long], config).text, '部署走 CI 流水线自动化方案')
  })

  it('文本按 mergeTextChars 截断', () => {
    const config = makeConfig({ dedup: { mergeTextChars: 10 } })
    const a = makeCard({ id: 'a', text: '部署走 CI 流水线自动化方案与回滚策略', createdAt: T0 })
    const b = makeCard({ id: 'b', text: '部署走 CI 流水线自动化方案与回滚策略', createdAt: T0 + DAY_MS })
    assert.ok([...mergeGroup([a, b], config).text].length <= 11)
  })

  it('normalized 用未截断的完整文本', () => {
    const config = makeConfig({ dedup: { mergeTextChars: 5 } })
    const a = makeCard({ id: 'a', text: '部署走 CI 流水线自动化方案', createdAt: T0 })
    const b = makeCard({ id: 'b', text: '部署走 CI 流水线自动化方案', createdAt: T0 + DAY_MS })
    const merged = mergeGroup([a, b], config)
    assert.ok(merged.normalized.length > merged.text.length)
  })

  it('标签并集去重，大小写不敏感', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, tags: ['部署', 'CI'] })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, tags: ['ci', '回滚'] })
    const merged = mergeGroup([a, b], config)
    assert.deepEqual(merged.tags, ['部署', 'CI', '回滚'])
  })

  it('实体并集去重', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, entities: ['src/a.ts'] })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, entities: ['src/b.ts'] })
    assert.deepEqual(mergeGroup([a, b], config).entities, ['src/a.ts', 'src/b.ts'])
  })

  it('修正记录全部保留并按时间升序', () => {
    const config = makeConfig()
    const revision = (at: number, previousText: string) => ({
      at, previousText, reason: '纠正', actor: 'manual' as const,
    })
    const a = makeCard({
      id: 'a', text: '部署走 CI', createdAt: T0,
      revisions: [revision(T0 + 2 * DAY_MS, '后')],
    })
    const b = makeCard({
      id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS,
      revisions: [revision(T0 + DAY_MS, '前')],
    })
    const merged = mergeGroup([a, b], config)
    assert.deepEqual(merged.revisions.map((item) => item.previousText), ['前', '后'])
  })

  it('mergeOf 记录被并入的卡 id（FR-A4 溯源）', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS })
    const merged = mergeGroup([a, b], config)
    assert.deepEqual(merged.mergeOf, ['b'])
  })

  it('mergeOf 继承被并入卡此前并入的 id（链式合并不丢溯源）', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, mergeOf: ['z'] })
    assert.deepEqual(mergeGroup([a, b], config).mergeOf, ['z', 'b'])
  })

  it('任一成员 pinned 则合并后 pinned', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, pinned: false })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, pinned: true })
    assert.equal(mergeGroup([a, b], config).pinned, true)
  })

  it('合并后状态为 active', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS })
    assert.equal(mergeGroup([a, b], config).status, 'active')
  })

  it('冲突列表并集，剔除自身 id', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, conflictOf: ['x'] })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, conflictOf: ['a'] })
    const merged = mergeGroup([a, b], config)
    assert.deepEqual(merged.conflictOf, ['x'])
  })

  it('单张卡合并返回自身内容（不抛错）', () => {
    const config = makeConfig()
    const only = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })
    const merged = mergeGroup([only], config)
    assert.equal(merged.id, 'a')
    assert.deepEqual(merged.mergeOf, [])
  })

  it('空数组抛 RangeError', () => {
    assert.throws(() => mergeGroup([], makeConfig()), RangeError)
  })

  it('不修改入参（纯函数）', () => {
    const config = makeConfig()
    const a = makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, tags: ['部署'] })
    const b = makeCard({ id: 'b', text: '部署走 CI', createdAt: T0 + DAY_MS, tags: ['CI'] })
    const snapshotA = { ...a, tags: [...a.tags] }
    mergeGroup([a, b], config)
    assert.deepEqual(a.tags, snapshotA.tags)
    assert.equal(a.id, snapshotA.id)
  })
})
