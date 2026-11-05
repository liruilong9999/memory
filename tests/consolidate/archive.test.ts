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
  applyArchiveRatio, hasOpenDue, isNeverArchiveKind, releaseExpiredDue, shouldArchive,
} from '../../src/consolidate/archive.ts'
import { applyRecord, createEmptyState } from '../../src/store/state.ts'
import type { JournalOp, MemoryCard } from '../../src/core/types.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

const T0 = 1_700_000_000_000

/**
 * 把操作序列重放到卡片表上，复用数据面的真实语义。
 *
 * 为什么不在测试里手写「归档之后卡长什么样」：那等于让测试自己维护一份
 * 字段约定，实现漏写时测试照样是绿的——测的是帮手，不是实现。
 *
 * @param cards - 初始卡片。
 * @param ops - 操作序列。
 * @returns 重放后的卡片表。
 */
function replayOps(
  cards: readonly MemoryCard[], ops: readonly JournalOp[],
): Map<string, MemoryCard> {
  const state = createEmptyState()
  for (const card of cards) state.cards.set(card.id, card)
  ops.forEach((op, index) => {
    // 记录的 `at` 必须与操作自带的 `at` 一致：数据面的 archive/restore 分支
    // 用的是 `record.at`（落库时刻），不是 `op.at`。真实写入路径里两者相同
    // （`store.append(op, undefined, now)` 把 now 同时给了两者），测试也要还原这一点，
    // 否则测出来的是「记录时刻」与「操作时刻」不一致时的行为，不是真实行为。
    const at = 'at' in op && typeof op.at === 'number' ? op.at : T0
    applyRecord(state, { v: 1, seq: index + 1, at, idempotencyKey: `t:${index}`, op })
  })
  return state.cards
}

describe('isNeverArchiveKind 永不归档类别（FR-C3）', () => {
  it('默认配置保护承诺、概念、经验', () => {
    const config = makeConfig()
    for (const kind of ['promise', 'concept', 'experience'] as const) {
      assert.equal(isNeverArchiveKind(makeCard({ id: kind, kind }), config), true, kind)
    }
  })

  it('核心事实受类别保护，事件不受（FR-C3）', () => {
    // 这条用例**曾经叫「事件、事实不受类别保护」**，断言 `fact === false`。
    // 它把「核心事实会被夜整理自动归档」这个缺陷**固化成了契约**：
    // 规格 `docs/1-需求规格.md:149` 原话是「永不归档类别（承诺、**核心事实**、
    // 长期偏好、感受）」，而默认配置里从来没有 `fact`。测试替实现打了掩护，
    // 于是缺陷既不会报错也不会变红，只是悄悄把该留的决策与结论挪进 archived。
    // 按 AGENTS.md「不写替实现打掩护的测试」——行为被判定为缺陷时，
    // 测试必须跟着改，而不是把缺陷写成契约。现在改断言，是因为**改的是实现**。
    //
    // 为什么两边都要断言：只断言 `fact` 受保护，无法区分「类别豁免真的生效」
    // 与「所有 kind 都被保护」。后者会让归档路径在数学上恒为空——
    // 不报错、不崩溃、测试全绿，只是那条路径一行都没真正执行过
    // （同源缺陷二十 / 二十六 / 三十二）。`event` 必须**不受**保护。
    const config = makeConfig()
    assert.equal(
      isNeverArchiveKind(makeCard({ id: 'fact', kind: 'fact' }), config), true,
      '核心事实必须受类别保护（FR-C3）',
    )
    assert.equal(
      isNeverArchiveKind(makeCard({ id: 'event', kind: 'event' }), config), false,
      '事件必须仍可归档，否则遗忘机制恒为空',
    )
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

  it('核心事实不被归档（FR-C3「永不归档类别」）', () => {
    // 这条守的是 FR-C3 原话里「**核心事实**」那一项（docs/1-需求规格.md:149）。
    // 修复前 `fact` 根本不在 `neverArchiveKinds` 里，于是「我决定数据库以后就用
    // PostgreSQL」这种结论性内容，只要强度衰减到阈值以下就会被夜整理自动归档。
    //
    // **前提断言不能省**：如果这张卡的强度本来就在阈值之上，它不归档是因为
    // 「不够弱」而不是因为「受类别保护」，测试就是假绿——它守的会是
    // `shouldArchive` 里更靠前的那道强度断言，而不是类别豁免这一条。
    const config = makeConfig()
    const card = lowStrength({ id: 'fact', kind: 'fact' })
    assert.ok(
      card.strength < config.forgetting.archiveThreshold,
      `前提：强度 ${card.strength} 必须严格低于阈值 ${config.forgetting.archiveThreshold}，`
      + '否则这条测试绿在强度上而不是绿在类别豁免上',
    )
    assert.equal(
      shouldArchive(card, config), false,
      '核心事实必须免于自动归档（FR-C3）',
    )
    // 配对断言：只证明「受保护的没被归档」不够，还要证明「同类里不受保护的
    // 确实会被归档」，否则把 shouldArchive 改成恒 false 这条也照样绿。
    assert.equal(
      shouldArchive(lowStrength({ id: 'event', kind: 'event' }), config), true,
      '对照：同样强度的事件卡必须可归档，证明归档路径不是空集',
    )
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

describe('归档与恢复的重放语义（FR-C2 / ST-7）', () => {
  it('归档后状态变为 archived', () => {
    const state = replayOps([makeCard({ id: 'a', strength: 0.1 })], [
      { op: 'archive', id: 'a', at: T0, reason: '测试' },
    ])
    assert.equal(state.get('a')?.status, 'archived')
  })

  it('归档不改强度：动作与时间流逝是两件事', () => {
    // 早期归档会乘一个 archiveRetention 打折强度，导致「同一动作做两次结果不同」，
    // 且 archive 操作不带强度、重放永远算不出这个乘法（见 archive.ts 尾注）。
    const state = replayOps([makeCard({ id: 'a', strength: 0.5 })], [
      { op: 'archive', id: 'a', at: T0, reason: '测试' },
    ])
    assert.equal(state.get('a')?.strength, 0.5)
  })

  it('归档后强度仍大于 0，不是清零', () => {
    const state = replayOps([makeCard({ id: 'a', strength: 0.1 })], [
      { op: 'archive', id: 'a', at: T0, reason: '测试' },
    ])
    assert.ok((state.get('a')?.strength ?? 0) > 0)
  })

  it('updatedAt 置为归档时刻', () => {
    const state = replayOps([makeCard({ id: 'a', createdAt: T0, updatedAt: T0 })], [
      { op: 'archive', id: 'a', at: T0 + 5 * DAY_MS, reason: '测试' },
    ])
    assert.equal(state.get('a')?.updatedAt, T0 + 5 * DAY_MS)
  })

  it('除状态与 updatedAt 外字段一律不变', () => {
    const card = makeCard({ id: 'a', text: '部署走 CI', tags: ['部署'], strength: 0.5 })
    const state = replayOps([card], [{ op: 'archive', id: 'a', at: T0, reason: '测试' }])
    const archived = state.get('a')
    assert.equal(archived?.id, card.id)
    assert.equal(archived?.text, card.text)
    assert.equal(archived?.strength, card.strength)
    assert.deepEqual(archived?.tags, card.tags)
  })

  it('归档 → 恢复往返后强度严格相等（FR-C2 遗忘可逆的直接证据）', () => {
    // 这条是「可逆」的本体：不是近似、不是打折后仍大于零，而是**一模一样**。
    const before = makeCard({ id: 'a', strength: 0.37, status: 'active' })
    const state = replayOps([before], [
      { op: 'archive', id: 'a', at: T0 + DAY_MS, reason: '测试' },
      { op: 'restore', id: 'a', at: T0 + 2 * DAY_MS },
    ])
    const restored = state.get('a')
    assert.equal(restored?.status, 'active')
    assert.equal(restored?.strength, before.strength)
  })

  it('归档 → 恢复 → 再归档，强度仍不变（同一动作可重复）', () => {
    const state = replayOps([makeCard({ id: 'a', strength: 0.37 })], [
      { op: 'archive', id: 'a', at: T0, reason: '测试' },
      { op: 'restore', id: 'a', at: T0 + DAY_MS },
      { op: 'archive', id: 'a', at: T0 + 2 * DAY_MS, reason: '测试' },
    ])
    assert.equal(state.get('a')?.strength, 0.37)
  })
})
