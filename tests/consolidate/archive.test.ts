/**
 * 归档面单测：什么时候允许「忘掉」一张卡。
 *
 * 对应需求：FR-C2（遗忘可逆）、FR-C3（阈值可配 + 永不归档类别）、
 * FR-C4（库增长有界）、ST-7（归档的记忆可恢复并正常召回）。
 *
 * @module tests/consolidate/archive.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyArchiveRatio, archiveCard, hasOpenDue, isNeverArchiveKind,
  releaseExpiredDue, shouldArchive,
} from '../../src/consolidate/archive.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

const T0 = 1_700_000_000_000

describe('isNeverArchiveKind 永不归档类别（FR-C3）', () => {
  it('默认配置保护承诺、概念、经验', () => {
    const config = makeConfig()
    for (const kind of ['promise', 'concept', 'experience'] as const) {
      assert.equal(isNeverArchiveKind(makeCard({ id: kind, kind }), config), true, kind)
    }
  })

  it('事件、事实不受类别保护', () => {
    const config = makeConfig()
    for (const kind of ['event', 'fact'] as const) {
      assert.equal(isNeverArchiveKind(makeCard({ id: kind, kind }), config), false, kind)
    }
  })

  it('感受受类别保护（起源 L11：只会留下感受，不该被自动归档）', () => {
    const config = makeConfig()
    assert.equal(isNeverArchiveKind(makeCard({ id: 'feeling', kind: 'feeling' }), config), true)
  })

  it('类别列表可配', () => {
    const config = makeConfig({ forgetting: { neverArchiveKinds: ['event'] } })
    assert.equal(isNeverArchiveKind(makeCard({ id: 'a', kind: 'event' }), config), true)
    assert.equal(isNeverArchiveKind(makeCard({ id: 'b', kind: 'promise' }), config), false)
  })
})

describe('hasOpenDue 未到期事项', () => {
  it('dueAt 有值为 true', () => {
    assert.equal(hasOpenDue(makeCard({ id: 'a', dueAt: T0 + DAY_MS })), true)
  })

  it('dueAt 为 null 或未定义为 false', () => {
    assert.equal(hasOpenDue(makeCard({ id: 'a', dueAt: null })), false)
    assert.equal(hasOpenDue(makeCard({ id: 'b' })), false)
  })
})

describe('releaseExpiredDue 清理过期到期时刻', () => {
  it('未到期的原样返回（同一引用）', () => {
    const card = makeCard({ id: 'a', dueAt: T0 + DAY_MS })
    assert.equal(releaseExpiredDue(card, T0), card)
  })

  it('已过期的清空 dueAt', () => {
    const card = makeCard({ id: 'a', dueAt: T0 })
    const released = releaseExpiredDue(card, T0 + DAY_MS)
    assert.equal(released.dueAt, null)
    assert.notEqual(released, card)
  })

  it('无 dueAt 的原样返回', () => {
    const card = makeCard({ id: 'a' })
    assert.equal(releaseExpiredDue(card, T0), card)
  })

  it('恰好到期的视为已过期', () => {
    const card = makeCard({ id: 'a', dueAt: T0 })
    assert.equal(releaseExpiredDue(card, T0).dueAt, null)
  })
})

describe('shouldArchive 归档判定（FR-C3 / FR-C4）', () => {
  const lowStrength = (over: Parameters<typeof makeCard>[0]) =>
    makeCard({ strength: 0.01, ...over })

  it('强度低于阈值且无豁免时可归档', () => {
    assert.equal(shouldArchive(lowStrength({ id: 'a', kind: 'event' }), makeConfig()), true)
  })

  it('autoArchive 关闭时一律不归档', () => {
    const config = makeConfig({ forgetting: { autoArchive: false } })
    assert.equal(shouldArchive(lowStrength({ id: 'a' }), config), false)
  })

  it('强度高于阈值时不归档', () => {
    const card = makeCard({ id: 'a', kind: 'event', strength: 0.5 })
    assert.equal(shouldArchive(card, makeConfig()), false)
  })

  it('强度恰好等于阈值时不归档（严格小于）', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', kind: 'event', strength: config.forgetting.archiveThreshold })
    assert.equal(shouldArchive(card, config), false)
  })

  it('pinned 的卡永不归档（优先级最高）', () => {
    assert.equal(shouldArchive(lowStrength({ id: 'a', pinned: true }), makeConfig()), false)
  })

  it('承诺类永不归档', () => {
    assert.equal(shouldArchive(lowStrength({ id: 'a', kind: 'promise' }), makeConfig()), false)
  })

  it('经验类永不归档', () => {
    assert.equal(shouldArchive(lowStrength({ id: 'a', kind: 'experience' }), makeConfig()), false)
  })

  it('挂着未到期事项时不归档', () => {
    assert.equal(
      shouldArchive(lowStrength({ id: 'a', dueAt: T0 + DAY_MS }), makeConfig()),
      false,
    )
  })

  it('已归档的卡不重复归档', () => {
    assert.equal(shouldArchive(lowStrength({ id: 'a', status: 'archived' }), makeConfig()), false)
  })

  it('已被合并的卡不归档（交由合并流程处理）', () => {
    assert.equal(shouldArchive(lowStrength({ id: 'a', mergedInto: 'x' }), makeConfig()), false)
  })

  it('阈值可配：调高阈值让更多卡可归档', () => {
    const config = makeConfig({ forgetting: { archiveThreshold: 0.9 } })
    assert.equal(shouldArchive(makeCard({ id: 'a', kind: 'event', strength: 0.5 }), config), true)
  })
})

describe('applyArchiveRatio 归档比例上限（P8 成本有界）', () => {
  it('空候选返回空', () => {
    assert.deepEqual(applyArchiveRatio([], 0.05, 100), [])
  })

  it('按「活跃总数 × 比例」截断', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      makeCard({ id: `c${index}`, strength: 0.01, createdAt: T0 + index }))
    // 上限 = floor(10 × 0.5) = 5，候选有 10 张，只归档 5 张。
    const picked = applyArchiveRatio(candidates, 0.5, 10)
    assert.equal(picked.length, 5)
  })

  it('候选数少于上限时全部归档', () => {
    const candidates = Array.from({ length: 3 }, (_, index) =>
      makeCard({ id: `c${index}`, strength: 0.01, createdAt: T0 + index }))
    assert.equal(applyArchiveRatio(candidates, 0.5, 100).length, 3)
  })

  it('优先归档强度最低的卡', () => {
    const candidates = [
      makeCard({ id: 'high', strength: 0.07, createdAt: T0 }),
      makeCard({ id: 'low', strength: 0.01, createdAt: T0 + DAY_MS }),
    ]
    const picked = applyArchiveRatio(candidates, 0.5, 2)
    assert.deepEqual(picked.map((card) => card.id), ['low'])
  })

  it('强度相同优先归档更老的卡', () => {
    const candidates = [
      makeCard({ id: 'new', strength: 0.01, createdAt: T0 + DAY_MS }),
      makeCard({ id: 'old', strength: 0.01, createdAt: T0 }),
    ]
    const picked = applyArchiveRatio(candidates, 0.5, 2)
    assert.deepEqual(picked.map((card) => card.id), ['old'])
  })

  it('小库（上限为 0）不归档任何卡', () => {
    const candidates = [makeCard({ id: 'a', strength: 0.01 })]
    assert.deepEqual(applyArchiveRatio(candidates, 0.05, 10), [])
  })

  it('比例夹到 0..1', () => {
    const candidates = [
      makeCard({ id: 'a', strength: 0.01, createdAt: T0 }),
      makeCard({ id: 'b', strength: 0.02, createdAt: T0 + 1 }),
    ]
    assert.equal(applyArchiveRatio(candidates, 5, 2).length, 2)
    assert.equal(applyArchiveRatio(candidates, -1, 2).length, 0)
  })

  it('比例非有限时视为 0', () => {
    const candidates = [makeCard({ id: 'a', strength: 0.01 })]
    assert.deepEqual(applyArchiveRatio(candidates, Number.NaN, 100), [])
  })

  it('totalActive 缺省取候选数', () => {
    const candidates = [
      makeCard({ id: 'a', strength: 0.01, createdAt: T0 }),
      makeCard({ id: 'b', strength: 0.02, createdAt: T0 + 1 }),
    ]
    assert.equal(applyArchiveRatio(candidates, 0.5).length, 1)
  })

  it('输出顺序稳定（ST-1）', () => {
    const make = () => [
      makeCard({ id: 'c', strength: 0.01, createdAt: T0 + 2 }),
      makeCard({ id: 'a', strength: 0.01, createdAt: T0 }),
      makeCard({ id: 'b', strength: 0.01, createdAt: T0 + 1 }),
    ]
    assert.deepEqual(
      applyArchiveRatio(make(), 1, 3).map((card) => card.id),
      applyArchiveRatio(make(), 1, 3).map((card) => card.id),
    )
  })
})

describe('archiveCard 归档动作（FR-C2 / ST-7）', () => {
  it('状态变为 archived', () => {
    const archived = archiveCard(makeCard({ id: 'a', strength: 0.1 }), T0, makeConfig())
    assert.equal(archived.status, 'archived')
  })

  it('按 archiveRetention 保留部分强度（恢复后能召回）', () => {
    const config = makeConfig({ forgetting: { archiveRetention: 0.6 } })
    const archived = archiveCard(makeCard({ id: 'a', strength: 0.5 }), T0, config)
    assert.ok(Math.abs(archived.strength - 0.3) < 1e-9)
  })

  it('归档后强度仍大于 0，不是清零', () => {
    const archived = archiveCard(makeCard({ id: 'a', strength: 0.1 }), T0, makeConfig())
    assert.ok(archived.strength > 0)
  })

  it('updatedAt 置为归档时刻', () => {
    const archived = archiveCard(makeCard({ id: 'a', createdAt: T0 }), T0 + 5 * DAY_MS, makeConfig())
    assert.equal(archived.updatedAt, T0 + 5 * DAY_MS)
  })

  it('保留 retention 之外的字段不变', () => {
    const card = makeCard({ id: 'a', text: '部署走 CI', tags: ['部署'], strength: 0.5 })
    const archived = archiveCard(card, T0, makeConfig())
    assert.equal(archived.id, card.id)
    assert.equal(archived.text, card.text)
    assert.deepEqual(archived.tags, card.tags)
  })

  it('不修改入参（纯函数）', () => {
    const card = makeCard({ id: 'a', strength: 0.5, status: 'active' })
    archiveCard(card, T0, makeConfig())
    assert.equal(card.status, 'active')
    assert.equal(card.strength, 0.5)
  })

  it('retention 越界被夹到 0..1', () => {
    const config = makeConfig({ forgetting: { archiveRetention: 5 } })
    assert.equal(archiveCard(makeCard({ id: 'a', strength: 0.5 }), T0, config).strength, 0.5)
  })

  it('强度非有限时归零', () => {
    const card = makeCard({ id: 'a', strength: Number.NaN })
    assert.equal(archiveCard(card, T0, makeConfig()).strength, 0)
  })
})
