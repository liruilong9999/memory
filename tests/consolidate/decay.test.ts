/**
 * 衰减面单测：遗忘曲线与情绪调制。
 *
 * 对应需求：FR-C4（库增长有界，归档的前提是强度掉到阈值以下）、
 * FR-D2（时间项由代码算，不由模型推断）、ST-1（确定性）。
 * 对应起源第 1 条：情绪越强，忘得越慢。
 *
 * @module tests/consolidate/decay.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  clamp01, decayCard, decayOriginAt, decayStrength, effectiveHalfLifeMs,
} from '../../src/consolidate/decay.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

const T0 = 1_700_000_000_000

describe('clamp01 夹紧', () => {
  it('区间内原样返回', () => {
    assert.equal(clamp01(0.5), 0.5)
    assert.equal(clamp01(0), 0)
    assert.equal(clamp01(1), 1)
  })

  it('越界夹到边界', () => {
    assert.equal(clamp01(-0.3), 0)
    assert.equal(clamp01(2.7), 1)
  })

  it('非有限数视为 0', () => {
    assert.equal(clamp01(Number.NaN), 0)
    assert.equal(clamp01(Number.POSITIVE_INFINITY), 0)
    assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0)
  })
})

describe('decayOriginAt 衰减起算时刻', () => {
  it('取 createdAt / updatedAt / lastAccessAt 的最大值', () => {
    const card = makeCard({
      id: 'a',
      createdAt: T0,
      updatedAt: T0 + DAY_MS,
      lastAccessAt: T0 + 2 * DAY_MS,
    })
    assert.equal(decayOriginAt(card), T0 + 2 * DAY_MS)
  })

  it('lastAccessAt 为 null 时退回到 createdAt / updatedAt', () => {
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0 + DAY_MS, lastAccessAt: null })
    assert.equal(decayOriginAt(card), T0 + DAY_MS)
  })

  it('lastAccessAt 早于 updatedAt 时不取它', () => {
    const card = makeCard({
      id: 'a',
      createdAt: T0,
      updatedAt: T0 + 5 * DAY_MS,
      lastAccessAt: T0 + DAY_MS,
    })
    assert.equal(decayOriginAt(card), T0 + 5 * DAY_MS)
  })
})

describe('effectiveHalfLifeMs 有效半衰期', () => {
  it('无情绪无访问时等于基准半衰期', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', emotional: 0, accessCount: 0 })
    assert.equal(effectiveHalfLifeMs(card, config), config.forgetting.halfLifeMs)
  })

  it('情绪强度拉长半衰期（起源第 1 条：强烈感受忘得更慢）', () => {
    const config = makeConfig()
    const calm = makeCard({ id: 'a', emotional: 0, accessCount: 0 })
    const intense = makeCard({ id: 'b', emotional: 1, accessCount: 0 })
    assert.ok(
      effectiveHalfLifeMs(intense, config) > effectiveHalfLifeMs(calm, config),
      '情绪强度为 1 的卡半衰期必须更长',
    )
  })

  it('情绪拉长幅度受 emotionalHalfLifeBoost 控制', () => {
    const config = makeConfig({ forgetting: { emotionalHalfLifeBoost: 2 } })
    const card = makeCard({ id: 'a', emotional: 1, accessCount: 0 })
    assert.equal(effectiveHalfLifeMs(card, config), config.forgetting.halfLifeMs * 2)
  })

  it('访问次数拉长半衰期', () => {
    const config = makeConfig()
    const fresh = makeCard({ id: 'a', accessCount: 0 })
    const used = makeCard({ id: 'b', accessCount: 5 })
    assert.ok(effectiveHalfLifeMs(used, config) > effectiveHalfLifeMs(fresh, config))
  })

  it('半衰期为非正时兜底为 1，避免除零', () => {
    const config = makeConfig({ forgetting: { halfLifeMs: 0 } })
    const card = makeCard({ id: 'a', emotional: 0, accessCount: 0 })
    assert.equal(effectiveHalfLifeMs(card, config), 1)
  })
})

describe('decayStrength 衰减', () => {
  it('同一时刻不衰减', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0, strength: 0.8 })
    assert.equal(decayStrength(card, T0, config), 0.8)
  })

  it('过一个半衰期强度减半', () => {
    const config = makeConfig()
    const card = makeCard({
      id: 'a', createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 1, emotional: 0, accessCount: 0,
    })
    const after = decayStrength(card, T0 + config.forgetting.halfLifeMs, config)
    assert.ok(Math.abs(after - 0.5) < 1e-9, `期望 0.5，实际 ${after}`)
  })

  it('两个半衰期衰减到四分之一', () => {
    const config = makeConfig()
    const card = makeCard({
      id: 'a', createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 1, emotional: 0, accessCount: 0,
    })
    const after = decayStrength(card, T0 + 2 * config.forgetting.halfLifeMs, config)
    assert.ok(Math.abs(after - 0.25) < 1e-9, `期望 0.25，实际 ${after}`)
  })

  it('情绪卡比平静卡衰减得慢', () => {
    const config = makeConfig()
    const at = T0 + 10 * DAY_MS
    const calm = makeCard({
      id: 'a', createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 1, emotional: 0, accessCount: 0,
    })
    const intense = makeCard({
      id: 'b', createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 1, emotional: 1, accessCount: 0,
    })
    assert.ok(decayStrength(intense, at, config) > decayStrength(calm, at, config))
  })

  it('时间倒流不做反向增强', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0, strength: 0.6 })
    assert.equal(decayStrength(card, T0 - DAY_MS, config), 0.6)
  })

  it('now 非有限时原样返回', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0, strength: 0.6 })
    assert.equal(decayStrength(card, Number.NaN, config), 0.6)
  })

  it('结果始终落在 0..1', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0, strength: 1 })
    const after = decayStrength(card, T0 + 1000 * DAY_MS, config)
    assert.ok(after >= 0 && after <= 1)
  })

  it('分次衰减与一次衰减等价（可叠加性）', () => {
    const config = makeConfig()
    const card = makeCard({
      id: 'a', createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 1, emotional: 0.5, accessCount: 2,
    })
    const mid = T0 + 3 * DAY_MS
    const oneShot = decayStrength(card, T0 + 6 * DAY_MS, config)

    const firstPass = decayCard(card, mid, config)
    const twoStep = decayStrength(firstPass, T0 + 6 * DAY_MS, config)

    assert.ok(Math.abs(oneShot - twoStep) < 1e-9, `一次 ${oneShot} vs 两次 ${twoStep}`)
  })
})

describe('decayCard 生成新卡', () => {
  it('无变化时返回同一对象引用', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0, strength: 0.5 })
    assert.equal(decayCard(card, T0, config), card)
  })

  it('有变化时更新 strength 与 updatedAt', () => {
    const config = makeConfig()
    const at = T0 + 30 * DAY_MS
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0, strength: 1 })
    const next = decayCard(card, at, config)
    assert.ok(next !== card)
    assert.ok(next.strength < card.strength)
    assert.equal(next.updatedAt, at)
  })

  it('不修改入参（纯函数）', () => {
    const config = makeConfig()
    const card = makeCard({ id: 'a', createdAt: T0, updatedAt: T0, strength: 1 })
    const snapshot = { ...card }
    decayCard(card, T0 + 30 * DAY_MS, config)
    assert.deepEqual(card, snapshot)
  })

  it('除 strength 与 updatedAt 外字段不变', () => {
    const config = makeConfig()
    const card = makeCard({
      id: 'a', text: '部署走 CI', createdAt: T0, updatedAt: T0, strength: 1, tags: ['部署'],
    })
    const next = decayCard(card, T0 + 30 * DAY_MS, config)
    assert.equal(next.id, card.id)
    assert.equal(next.text, card.text)
    assert.deepEqual(next.tags, card.tags)
  })
})
