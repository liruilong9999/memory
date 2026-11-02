/**
 * 夜整理单测：去重 → 合并 → 降权 → 归档 → 连边 的完整链路。
 *
 * 对应需求：FR-C1（夜整理最小集 + 变更日志）、FR-C2（遗忘可逆）、
 * FR-C4（库增长有界）、ST-1（确定性）、ST-7（归档可恢复）。
 * 对应起源第 4 条：「今日记忆渐进累积，夜晚休眠整理，很长时间迭代」。
 *
 * @module tests/consolidate/nightly.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runConsolidation } from '../../src/consolidate/nightly.ts'
import { decayCard } from '../../src/consolidate/decay.ts'
import { releaseExpiredDue } from '../../src/consolidate/archive.ts'
import { applyRecord, createEmptyState } from '../../src/store/state.ts'
import type { JournalOp, MemoryCard } from '../../src/core/types.ts'
import { DAY_MS, makeCard, makeConfig } from './fixtures.ts'

const T0 = 1_700_000_000_000

/**
 * 测试统一使用的时区。
 *
 * 刻意用东八区而不是 `'UTC'`：自然日边界（FR-D4）在 UTC 下与东八区不同，
 * 用 UTC 测出来的「一天」在东八区用户眼里是错的，而测试仍然会绿。
 * 用真实时区测，边界才真的被验证过。
 */
const TZ = 'Asia/Shanghai'

/**
 * 把操作序列应用到卡片数组上，模拟数据面重放。
 *
 * **这里必须走真实的 `applyRecord`，不许自己手写字段语义。**
 * 早期版本在本文件里手抄了一遍「merge 之后被并入的卡变成什么样」，
 * 于是测试和生产代码各自维护一套字段约定：生产代码漏写 `status: 'archived'`，
 * 测试帮手自己补上了，断言永远是绿的——测的是帮手，不是实现。
 * 现在直接调数据面，两边共用同一份语义，实现漂了测试就会红。
 *
 * @param cards - 初始卡片。
 * @param ops - 待重放的操作序列。
 * @returns 重放后的卡片表。
 */
function replay(cards: readonly MemoryCard[], ops: readonly JournalOp[]): Map<string, MemoryCard> {
  return replayState(cards, ops).cards
}

/**
 * 把操作序列重放成完整状态（卡片 + 边）。
 *
 * @param cards - 初始卡片。
 * @param ops - 待重放的操作序列。
 * @returns 重放后的状态。
 */
function replayState(cards: readonly MemoryCard[], ops: readonly JournalOp[]) {
  const state = createEmptyState()
  for (const card of cards) state.cards.set(card.id, card)
  ops.forEach((op, index) => {
    // 记录时刻取操作自带的 `at`：真实写入路径 `store.append(op, undefined, now)`
    // 把同一个 now 同时给了记录与操作，重放时两处必须一致。
    const at = 'at' in op && typeof op.at === 'number' ? op.at : 0
    applyRecord(state, { v: 1, seq: index + 1, at, idempotencyKey: `test:${index}`, op })
  })
  return state
}

describe('runConsolidation 开关与空输入', () => {
  it('开关关闭时不做任何变更，但仍给出可读报告', () => {
    const config = makeConfig({ consolidation: { enabled: false } })
    const cards = [makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })]
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    assert.equal(result.ops.length, 0)
    assert.equal(result.report.merged, 0)
    assert.equal(result.report.archived, 0)
    assert.equal(result.report.decayed, 0)
    assert.ok(result.report.notes.length > 0)
  })

  it('空库整理不抛错，报告可读', () => {
    const result = runConsolidation({ cards: [] }, makeConfig(), T0, TZ)
    assert.equal(result.ops.length, 0)
    assert.equal(result.report.beforeActive, 0)
    assert.equal(result.report.afterActive, 0)
    assert.ok(result.report.notes.length > 0)
  })

  it('接受 MemoryState 形态的 Map 输入', () => {
    const cards = new Map([['a', makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })]])
    const result = runConsolidation({ cards }, makeConfig(), T0, TZ)
    assert.equal(result.report.beforeActive, 1)
  })

  it('缺省 edges 视为空', () => {
    const result = runConsolidation({ cards: [] }, makeConfig(), T0, TZ)
    assert.deepEqual(result.edges, [])
  })
})

describe('runConsolidation 衰减（FR-C4）', () => {
  it('长期未访问的卡强度下降并写入 put', () => {
    const config = makeConfig()
    const cards = [makeCard({
      id: 'a', text: '部署走 CI', createdAt: T0, updatedAt: T0,
      lastAccessAt: null, strength: 1, emotional: 0, accessCount: 0,
    })]
    const result = runConsolidation({ cards }, config, T0 + 60 * DAY_MS, TZ)
    const puts = result.ops.filter((op) => op.op === 'put')
    assert.equal(puts.length, 1)
    assert.ok(result.report.decayed >= 1)
  })

  it('刚写入的卡不产生衰减操作', () => {
    const cards = [makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, updatedAt: T0, strength: 1 })]
    const result = runConsolidation({ cards }, makeConfig(), T0, TZ)
    assert.equal(result.ops.filter((op) => op.op === 'put').length, 0)
    assert.equal(result.report.decayed, 0)
  })

  it('情绪强的卡衰减得更慢（起源第 1 条）', () => {
    const config = makeConfig()
    const at = T0 + 30 * DAY_MS
    const calm = makeCard({
      id: 'calm', text: '部署走 CI 甲', createdAt: T0, updatedAt: T0,
      lastAccessAt: null, strength: 1, emotional: 0, accessCount: 0,
    })
    const intense = makeCard({
      id: 'intense', text: '部署走 CI 乙', createdAt: T0, updatedAt: T0,
      lastAccessAt: null, strength: 1, emotional: 1, accessCount: 0,
    })
    const result = runConsolidation({ cards: [calm, intense] }, config, at, TZ)
    const map = replay([calm, intense], result.ops)
    const calmStrength = map.get('calm')?.strength ?? 1
    const intenseStrength = map.get('intense')?.strength ?? 1
    assert.ok(intenseStrength > calmStrength)
  })

  it('过期到期时刻在整理时被清掉', () => {
    const cards = [makeCard({ id: 'a', text: '提醒我交报告', dueAt: T0, createdAt: T0 })]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    const map = replay(cards, result.ops)
    assert.equal(map.get('a')?.dueAt, null)
  })
})

describe('runConsolidation 去重合并（FR-C1）', () => {
  it('重复卡被合并为一张，其余标记 mergedInto', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const mergeOps = result.ops.filter((op) => op.op === 'merge')
    assert.equal(mergeOps.length, 1)
    assert.equal(result.report.merged, 1)

    const map = replay(cards, result.ops)
    assert.equal(map.get('b')?.mergedInto, 'a')
    assert.equal(map.get('a')?.mergedInto, undefined)
  })

  it('合并后活跃卡数减少', () => {
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    assert.ok(result.report.afterActive < result.report.beforeActive)
  })

  it('合并保留被并入卡的全部溯源（FR-A4）', () => {
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    const merged = [...replay(cards, result.ops).values()].find((card) => card.id === 'a')
    assert.deepEqual(merged?.mergeOf, ['b'])
  })

  it('不重复的卡不被合并', () => {
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '今天天气不错适合散步', createdAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    assert.equal(result.report.merged, 0)
  })
})

describe('runConsolidation 归档（FR-C2 / FR-C3 / ST-7）', () => {
  it('强度极低的卡被归档', () => {
    // 默认 maxArchiveRatio 是 5%，1 张卡时 floor(1×0.05)=0（刻意的保守），
    // 所以这里显式放开比例上限，专注验证「阈值判定 → 归档动作」这条链路。
    const config = makeConfig({
      forgetting: { archiveThreshold: 0.5 },
      consolidation: { maxArchiveRatio: 1 },
    })
    const cards = [makeCard({
      id: 'a', text: '部署走 CI 甲', kind: 'event', createdAt: T0, updatedAt: T0,
      lastAccessAt: null, strength: 0.1, emotional: 0, accessCount: 0,
    })]
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    assert.ok(result.report.archived >= 1)
    assert.equal(replay(cards, result.ops).get('a')?.status, 'archived')
  })

  it('pinned 的卡不被归档（FR-C3）', () => {
    const config = makeConfig({ forgetting: { archiveThreshold: 0.5 } })
    const cards = [makeCard({
      id: 'a', text: '部署走 CI', kind: 'event', pinned: true,
      createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 0.01, emotional: 0, accessCount: 0,
    })]
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    assert.equal(result.report.archived, 0)
    assert.equal(replay(cards, result.ops).get('a')?.status, 'active')
  })

  it('承诺类不被归档（FR-C3）', () => {
    const config = makeConfig({ forgetting: { archiveThreshold: 0.5 } })
    const cards = [makeCard({
      id: 'a', text: '答应明天交报告', kind: 'promise',
      createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 0.01, emotional: 0, accessCount: 0,
    })]
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    assert.equal(result.report.archived, 0)
  })

  it('归档比例上限生效，不会一次清空（P8）', () => {
    const config = makeConfig({
      forgetting: { archiveThreshold: 1 },
      consolidation: { maxArchiveRatio: 0.1 },
    })
    const cards = Array.from({ length: 20 }, (_, index) => makeCard({
      id: `c${index}`, kind: 'event', createdAt: T0 + index, updatedAt: T0 + index,
      lastAccessAt: null, strength: 0.01, emotional: 0, accessCount: 0,
    }))
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    // 上限 = floor(20 × 0.1) = 2
    assert.equal(result.report.archived, 2)
  })

  it('归档不改强度，恢复后与归档前严格相等（FR-C2 / ST-7）', () => {
    const config = makeConfig({
      forgetting: { archiveThreshold: 0.5 },
      consolidation: { maxArchiveRatio: 1 },
    })
    const cards = [makeCard({
      id: 'a', kind: 'event', createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 0.1, emotional: 0, accessCount: 0,
    })]
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    const archived = replay(cards, result.ops).get('a')
    assert.equal(archived?.status, 'archived')
    // 归档动作本身不打折：归档后的强度必须**严格等于**纯衰减算出来的值。
    // 早期这里写的是 `assert.equal(archived?.strength, archived?.strength)`——
    // 自己等于自己，永远为真，等于什么都没验证。真正的判据是「归档这一步
    // 没有额外乘任何系数」，所以拿独立算出的衰减值来比。
    const decayedOnly = decayCard(releaseExpiredDue(cards[0]!, T0 + 30 * DAY_MS), T0 + 30 * DAY_MS, config)
    assert.equal(archived?.strength, decayedOnly.strength)
    assert.ok((archived?.strength ?? 0) > 0)
  })

  it('刚被合并掉的卡不会被同时归档', () => {
    const config = makeConfig({
      forgetting: { archiveThreshold: 1 },
      consolidation: { maxArchiveRatio: 1 },
    })
    const cards = [
      makeCard({
        id: 'a', kind: 'event', text: '部署走 CI 流水线', createdAt: T0,
        updatedAt: T0, lastAccessAt: null, strength: 0.01, emotional: 0, accessCount: 0,
      }),
      makeCard({
        id: 'b', kind: 'event', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS,
        updatedAt: T0 + DAY_MS, lastAccessAt: null, strength: 0.01, emotional: 0, accessCount: 0,
      }),
    ]
    const result = runConsolidation({ cards }, config, T0 + 2 * DAY_MS, TZ)
    const archiveOps = result.ops.filter((op) => op.op === 'archive')
    assert.ok(archiveOps.every((op) => op.op !== 'archive' || op.id !== 'b'))
  })
})

describe('runConsolidation 连边（FR-C1 重建索引）', () => {
  it('共享实体的活跃卡之间产生边', () => {
    const cards = [
      makeCard({ id: 'a', text: '部署脚本在 build.sh', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', text: 'build.sh 需要加执行权限', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    assert.ok(result.ops.some((op) => op.op === 'edge'))
    assert.ok(result.edges.length > 0)
  })

  it('已存在的边不重复产出（ST-2 幂等）', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署脚本在 build.sh', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', text: 'build.sh 需要加执行权限', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
    ]
    const first = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const second = runConsolidation({ cards, edges: first.edges }, config, T0 + DAY_MS, TZ)
    assert.equal(second.ops.filter((op) => op.op === 'edge').length, 0)
  })
})

describe('runConsolidation 上限与确定性（P8 / ST-1）', () => {
  it('超过 maxCardsPerRun 的卡顺延，报告里说明', () => {
    const config = makeConfig({ consolidation: { maxCardsPerRun: 2 } })
    const cards = Array.from({ length: 5 }, (_, index) => makeCard({
      id: `c${index}`, createdAt: T0 + index, updatedAt: T0 + index,
      lastAccessAt: null, strength: 1, emotional: 0, accessCount: 0,
    }))
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    assert.ok(result.report.notes.some((note) => note.includes('顺延')))
  })

  it('同样输入两次整理得到完全相同的操作（ST-1）', () => {
    const config = makeConfig()
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', entities: ['build.sh'], createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', entities: ['build.sh'], createdAt: T0 + DAY_MS }),
      makeCard({ id: 'c', text: '数据库迁移用 Alembic', createdAt: T0 + 2 * DAY_MS }),
    ]
    const first = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    const second = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    assert.deepEqual(first.ops, second.ops)
    assert.deepEqual(first.report, second.report)
  })

  it('报告里的活跃数前后一致可核对', () => {
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    assert.equal(result.report.beforeActive, 2)
    assert.equal(result.report.afterActive, 1)
  })

  it('报告包含人可读的变更摘要（FR-C1）', () => {
    const cards = [makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 })]
    const result = runConsolidation({ cards }, makeConfig(), T0 + 30 * DAY_MS, TZ)
    assert.ok(result.report.notes[0]?.includes('夜整理完成'))
  })

  it('整理后的卡片视图包含未变更的卡', () => {
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI', createdAt: T0 }),
      makeCard({ id: 'b', text: '今天天气不错', createdAt: T0 }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0, TZ)
    assert.equal(result.cards.length, 2)
  })

  it('不修改入参卡片（纯函数）', () => {
    const cards = [makeCard({ id: 'a', text: '部署走 CI', createdAt: T0, strength: 1 })]
    const snapshot = { ...cards[0]! }
    runConsolidation({ cards }, makeConfig(), T0 + 30 * DAY_MS, TZ)
    assert.deepEqual(cards[0], snapshot)
  })
})

describe('runConsolidation 返回值与重放一致（P2 事件日志是唯一真相源）', () => {
  it('返回的 cards 与重放 ops 得到的 cards 逐字段一致', () => {
    // 这是本文件最重要的断言：`cards` 曾被手工维护成第二份真相，
    // 与数据面重放结果漂移（合并时漏写 status/updatedAt）。
    // 这条一旦红，说明整理层又在自作主张定义字段语义。
    const config = makeConfig({
      forgetting: { archiveThreshold: 0.5 },
      consolidation: { maxArchiveRatio: 1 },
    })
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0, updatedAt: T0, strength: 0.1, lastAccessAt: null }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS, updatedAt: T0 + DAY_MS, strength: 0.1, lastAccessAt: null }),
      makeCard({ id: 'c', text: '数据库迁移用 Alembic', createdAt: T0, updatedAt: T0, strength: 1, lastAccessAt: null }),
    ]
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    const replayed = replayState(cards, result.ops)
    const returned = new Map(result.cards.map((card) => [card.id, card]))
    assert.deepEqual([...returned.keys()].sort(), [...replayed.cards.keys()].sort())
    for (const [id, card] of replayed.cards) {
      assert.deepEqual(returned.get(id), card, `卡片 ${id} 与重放结果不一致`)
    }
  })

  it('被合并掉的卡在返回值里也是 archived + mergedInto（不是只有 mergedInto）', () => {
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0, updatedAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS, updatedAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    const victim = result.cards.find((card) => card.id === 'b')
    assert.equal(victim?.mergedInto, 'a')
    assert.equal(victim?.status, 'archived', '被合并的卡必须作废，否则它还会被召回')
    assert.equal(victim?.updatedAt, T0 + DAY_MS, 'updatedAt 应推进到合并时刻')
  })

  it('合并产生的 supersedes 边出现在返回的 edges 里', () => {
    // 数据面 merge 分支会自动建 supersedes 边；整理层返回的 edges 必须包含它，
    // 否则调用方拿到的图谱视图缺边，而重放日志又有一条——两份真相。
    const cards = [
      makeCard({ id: 'a', text: '部署走 CI 流水线', createdAt: T0, updatedAt: T0 }),
      makeCard({ id: 'b', text: '部署走 CI 流水线', createdAt: T0 + DAY_MS, updatedAt: T0 + DAY_MS }),
    ]
    const result = runConsolidation({ cards }, makeConfig(), T0 + DAY_MS, TZ)
    const replayed = replayState(cards, result.ops)
    assert.deepEqual(
      result.edges.map((edge) => edge.id).sort(),
      [...replayed.edges.keys()].sort(),
    )
    assert.ok(result.edges.some((edge) => edge.relation === 'supersedes'))
  })

  it('归档不改强度：返回值与重放一致且强度未被额外打折', () => {
    const config = makeConfig({
      forgetting: { archiveThreshold: 0.5 },
      consolidation: { maxArchiveRatio: 1 },
    })
    const cards = [makeCard({
      id: 'a', kind: 'event', createdAt: T0, updatedAt: T0, lastAccessAt: null,
      strength: 0.1, emotional: 0, accessCount: 0,
    })]
    const result = runConsolidation({ cards }, config, T0 + 30 * DAY_MS, TZ)
    const archived = result.cards.find((card) => card.id === 'a')
    assert.equal(archived?.status, 'archived')
    // 强度只由衰减决定（decay 之后的值），归档动作不再乘任何系数。
    assert.deepEqual(archived, replayState(cards, result.ops).cards.get('a'))
  })
})
