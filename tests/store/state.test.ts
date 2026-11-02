/**
 * 状态重放单测：全部 JournalOp 的投影语义、幂等、确定性与硬删除清理。
 *
 * 对应需求：FR-A2（幂等）、FR-A4（来源指针）、FR-A5（修正历史）、
 * FR-C2（遗忘可逆）、ST-1（确定性）、ST-7（遗忘可逆）。
 *
 * @module tests/store/state.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildEdgeId, MEMORY_DOMAINS, MEMORY_KINDS } from '../../src/core/types.ts'
import type { JournalRecord, MemoryCard, MemoryEdge } from '../../src/core/types.ts'
import {
  EMPTY_STATE, applyRecord, applyRecordPure, cloneState, countCards, createEmptyState,
  edgesOf, filterCards, getCard, rebuildState,
} from '../../src/store/state.ts'
import { makeCard, makeRecord, makeSource } from './helpers.ts'

/** 造一条 put 记录。 */
function putRecord(seq: number, card: MemoryCard, key = `put-${seq}`): JournalRecord {
  return makeRecord(seq, { op: 'put', card }, key)
}

/** 造一条边。 */
function makeEdge(from: string, to: string, weight = 0.8): MemoryEdge {
  return {
    id: buildEdgeId(from, to, 'same-topic'),
    from,
    to,
    relation: 'same-topic',
    weight,
    createdAt: 1_700_000_000_000,
  }
}

describe('put 投影', () => {
  it('写入后应能按 id 取到卡片', () => {
    const state = createEmptyState()
    const card = makeCard()
    applyRecord(state, putRecord(1, card))
    assert.deepEqual(getCard(state, card.id), card)
    assert.equal(state.lastSeq, 1)
  })

  it('同 id 再写入应整卡覆盖', () => {
    const state = createEmptyState()
    const card = makeCard()
    applyRecord(state, putRecord(1, card))
    applyRecord(state, putRecord(2, { ...card, text: '更新后的文本', updatedAt: 2 }))
    const stored = getCard(state, card.id)
    assert.equal(stored?.text, '更新后的文本')
    assert.equal(state.cards.size, 1)
  })

  it('来源指针应原样保留（FR-A4）', () => {
    const state = createEmptyState()
    const source = makeSource({ sessionId: 's-9', turn: 3, step: 2, seq: 77, eventType: 'assistant/message' })
    const card = makeCard({ source })
    applyRecord(state, putRecord(1, card))
    assert.deepEqual(getCard(state, card.id)?.source, source)
  })

  it('结构非法的卡片应被跳过而不是抛错', () => {
    const state = createEmptyState()
    const record = makeRecord(1, { op: 'put', card: { id: '' } as unknown as MemoryCard })
    assert.doesNotThrow(() => applyRecord(state, record))
    assert.equal(state.cards.size, 0)
  })

  it('缺省字段的历史卡片应被补齐', () => {
    const state = createEmptyState()
    const partial = {
      id: 'legacy-1',
      text: '老版本卡片',
      source: { sessionId: 's', turn: 1, step: 1, seq: 1, eventType: 'user/message' },
    } as unknown as MemoryCard
    applyRecord(state, makeRecord(1, { op: 'put', card: partial }))
    const card = getCard(state, 'legacy-1')
    assert.equal(card?.status, 'active')
    assert.deepEqual(card?.tags, [])
    assert.equal(card?.accessCount, 0)
    assert.equal(card?.pinned, false)
  })
})

describe('幂等', () => {
  it('同一条记录应用两次只生效一次', () => {
    const state = createEmptyState()
    const card = makeCard()
    const record = putRecord(1, card, 'same')
    applyRecord(state, record)
    applyRecord(state, record)
    assert.equal(state.cards.size, 1)
    assert.equal(state.seenKeys.size, 1)
  })

  it('幂等键相同但内容不同的记录应被忽略（FR-A2）', () => {
    const state = createEmptyState()
    const card = makeCard()
    applyRecord(state, putRecord(1, card, 'k'))
    applyRecord(state, putRecord(2, { ...card, text: '不该生效' }, 'k'))
    assert.equal(getCard(state, card.id)?.text, card.text)
  })

  it('对只读空状态应用记录应抛错', () => {
    assert.throws(() => applyRecord(EMPTY_STATE, putRecord(1, makeCard())), /只读/u)
  })
})

describe('revise 修正历史', () => {
  it('修正后应保留旧版本（FR-A5）', () => {
    const state = createEmptyState()
    const card = makeCard({ text: '旧结论' })
    applyRecord(state, putRecord(1, card))
    applyRecord(state, makeRecord(2, {
      op: 'revise', id: card.id, text: '新结论', normalized: '新结论', reason: '用户纠正', at: 2, actor: 'manual',
    }))
    const stored = getCard(state, card.id)
    assert.equal(stored?.text, '新结论')
    assert.equal(stored?.revisions.length, 1)
    assert.equal(stored?.revisions[0]?.previousText, '旧结论')
    assert.equal(stored?.revisions[0]?.reason, '用户纠正')
    assert.equal(stored?.revisions[0]?.actor, 'manual')
  })

  it('多次修正应累积历史且按发生顺序排列', () => {
    const state = createEmptyState()
    const card = makeCard({ text: 'v1', createdAt: 0, updatedAt: 0 })
    applyRecord(state, putRecord(1, card))
    const second = { ...makeRecord(2, {
      op: 'revise' as const, id: card.id, text: 'v2', normalized: 'v2', reason: 'r2', at: 2, actor: 'system' as const,
    }), at: 2 }
    const third = { ...makeRecord(3, {
      op: 'revise' as const, id: card.id, text: 'v3', normalized: 'v3', reason: 'r3', at: 3, actor: 'system' as const,
    }), at: 3 }
    applyRecord(state, second)
    applyRecord(state, third)
    const stored = getCard(state, card.id)
    assert.equal(stored?.revisions.length, 2)
    assert.deepEqual(stored?.revisions.map((item) => item.previousText), ['v1', 'v2'])
    // updatedAt 取「卡片原值」与「修正时刻」中较晚者，这里修正时刻更大。
    assert.equal(stored?.updatedAt, 3)
  })

  it('修正不存在的卡应被忽略', () => {
    const state = createEmptyState()
    assert.doesNotThrow(() => applyRecord(state, makeRecord(1, {
      op: 'revise', id: 'ghost', text: 'x', normalized: 'x', reason: 'r', at: 1, actor: 'system',
    })))
    assert.equal(state.cards.size, 0)
  })
})

describe('touch 访问', () => {
  it('访问后计数加一、刷新强度与最后访问时刻', () => {
    const state = createEmptyState()
    const card = makeCard()
    applyRecord(state, putRecord(1, card))
    applyRecord(state, makeRecord(2, { op: 'touch', id: card.id, at: 12345, strength: 0.9 }))
    const stored = getCard(state, card.id)
    assert.equal(stored?.accessCount, 1)
    assert.equal(stored?.lastAccessAt, 12345)
    assert.equal(stored?.strength, 0.9)
  })

  it('强度应被夹到 0..1', () => {
    const state = createEmptyState()
    const card = makeCard()
    applyRecord(state, putRecord(1, card))
    applyRecord(state, makeRecord(2, { op: 'touch', id: card.id, at: 1, strength: 3 }))
    assert.equal(getCard(state, card.id)?.strength, 1)
    applyRecord(state, makeRecord(3, { op: 'touch', id: card.id, at: 2, strength: -2 }))
    assert.equal(getCard(state, card.id)?.strength, 0)
  })
})

describe('archive / restore 遗忘可逆', () => {
  it('归档后状态变 archived，恢复后回到 active（FR-C2 / ST-7）', () => {
    const state = createEmptyState()
    const card = makeCard()
    applyRecord(state, putRecord(1, card))
    applyRecord(state, makeRecord(2, { op: 'archive', id: card.id, at: 2, reason: '低强度' }))
    assert.equal(getCard(state, card.id)?.status, 'archived')
    applyRecord(state, makeRecord(3, { op: 'restore', id: card.id, at: 3 }))
    assert.equal(getCard(state, card.id)?.status, 'active')
  })

  it('归档不删除卡片', () => {
    const state = createEmptyState()
    const card = makeCard()
    applyRecord(state, putRecord(1, card))
    applyRecord(state, makeRecord(2, { op: 'archive', id: card.id, at: 2, reason: 'r' }))
    assert.equal(state.cards.size, 1)
    assert.equal(countCards(state, 'archived'), 1)
    assert.equal(countCards(state, 'active'), 0)
  })
})

describe('merge 合并', () => {
  it('被合并的卡应标记 mergedInto 并归档，合并卡应记录 mergeOf', () => {
    const state = createEmptyState()
    const a = makeCard({ id: 'a', text: '结论 A' })
    const b = makeCard({ id: 'b', text: '结论 B' })
    const into = makeCard({ id: 'into', text: '合并后的结论' })
    applyRecord(state, putRecord(1, a))
    applyRecord(state, putRecord(2, b))
    applyRecord(state, makeRecord(3, { op: 'merge', ids: ['a', 'b'], into, at: 3 }))

    assert.equal(getCard(state, 'a')?.mergedInto, 'into')
    assert.equal(getCard(state, 'b')?.status, 'archived')
    assert.deepEqual(getCard(state, 'into')?.mergeOf, ['a', 'b'])
  })

  it('合并应建立 supersedes 边', () => {
    const state = createEmptyState()
    const a = makeCard({ id: 'a' })
    applyRecord(state, putRecord(1, a))
    applyRecord(state, makeRecord(2, {
      op: 'merge', ids: ['a'], into: makeCard({ id: 'into' }), at: 2,
    }))
    const edge = state.edges.get(buildEdgeId('a', 'into', 'supersedes'))
    assert.ok(edge !== undefined)
    assert.equal(edge?.relation, 'supersedes')
  })

  it('合并时重复合并同一批卡不应产生重复的 mergeOf', () => {
    const state = createEmptyState()
    const a = makeCard({ id: 'a' })
    applyRecord(state, putRecord(1, a))
    const into = makeCard({ id: 'into', mergeOf: ['a'] })
    applyRecord(state, makeRecord(2, { op: 'merge', ids: ['a'], into, at: 2 }))
    assert.deepEqual(getCard(state, 'into')?.mergeOf, ['a'])
  })
})

describe('edge 图谱边', () => {
  it('写入后可按端点查到边', () => {
    const state = createEmptyState()
    const a = makeCard({ id: 'a' })
    const b = makeCard({ id: 'b' })
    applyRecord(state, putRecord(1, a))
    applyRecord(state, putRecord(2, b))
    const edge = makeEdge('a', 'b')
    applyRecord(state, makeRecord(3, { op: 'edge', edge }))
    assert.deepEqual(edgesOf(state, 'a').map((item) => item.id), [edge.id])
    assert.deepEqual(edgesOf(state, 'b').map((item) => item.id), [edge.id])
  })

  it('悬空边应在重放结束时被清理', () => {
    const state = createEmptyState()
    applyRecord(state, putRecord(1, makeCard({ id: 'a' })))
    applyRecord(state, makeRecord(2, { op: 'edge', edge: makeEdge('a', 'ghost') }))
    const rebuilt = rebuildState([putRecord(1, makeCard({ id: 'a' })), makeRecord(2, { op: 'edge', edge: makeEdge('a', 'ghost') })])
    assert.equal(rebuilt.edges.size, 0)
    // applyRecord 本身不清理，清理发生在 rebuildState 收尾。
    assert.equal(state.edges.size, 1)
  })
})

describe('purge 硬删除', () => {
  it('删除卡片后应不可见，且相关边被清理', () => {
    const state = createEmptyState()
    const a = makeCard({ id: 'a' })
    const b = makeCard({ id: 'b' })
    applyRecord(state, putRecord(1, a))
    applyRecord(state, putRecord(2, b))
    applyRecord(state, makeRecord(3, { op: 'edge', edge: makeEdge('a', 'b') }))
    applyRecord(state, makeRecord(4, { op: 'purge', id: 'a', at: 4 }))
    assert.equal(getCard(state, 'a'), undefined)
    assert.equal(state.edges.size, 0)
    assert.deepEqual(edgesOf(state, 'b'), [])
  })

  it('删除卡片应清理其他卡片对它的引用', () => {
    const state = createEmptyState()
    const a = makeCard({ id: 'a' })
    const b = makeCard({ id: 'b', conflictOf: ['a'], mergeOf: ['a'], mergedInto: 'a' })
    applyRecord(state, putRecord(1, a))
    applyRecord(state, putRecord(2, b))
    applyRecord(state, makeRecord(3, { op: 'purge', id: 'a', at: 3 }))
    const stored = getCard(state, 'b')
    assert.deepEqual(stored?.conflictOf, [])
    assert.deepEqual(stored?.mergeOf, [])
    assert.equal(stored?.mergedInto, undefined)
  })
})

describe('重放确定性（ST-1）', () => {
  it('同一批记录重放两次得到完全相同的结果', () => {
    const records: JournalRecord[] = [
      putRecord(1, makeCard({ id: 'a', text: '甲' })),
      putRecord(2, makeCard({ id: 'b', text: '乙' })),
      makeRecord(3, { op: 'revise', id: 'a', text: '甲2', normalized: '甲2', reason: 'r', at: 3, actor: 'manual' }),
      makeRecord(4, { op: 'touch', id: 'b', at: 4, strength: 0.5 }),
      makeRecord(5, { op: 'archive', id: 'b', at: 5, reason: '低强度' }),
      makeRecord(6, { op: 'edge', edge: makeEdge('a', 'b') }),
    ]
    const first = rebuildState(records)
    const second = rebuildState(records)
    assert.deepEqual([...first.cards.entries()], [...second.cards.entries()])
    assert.deepEqual([...first.edges.entries()], [...second.edges.entries()])
    assert.equal(first.lastSeq, second.lastSeq)
  })

  it('重放 10 次结果一致（ST-1 的 10 次口径）', () => {
    const records: JournalRecord[] = [
      putRecord(1, makeCard({ id: 'a' })),
      makeRecord(2, { op: 'touch', id: 'a', at: 2, strength: 0.6 }),
    ]
    const baseline = JSON.stringify([...rebuildState(records).cards.entries()])
    for (let i = 0; i < 10; i += 1) {
      assert.equal(JSON.stringify([...rebuildState(records).cards.entries()]), baseline)
    }
  })

  it('重复记录混在日志里重放也应得到同样结果（ST-2）', () => {
    const card = makeCard({ id: 'a' })
    const record = putRecord(1, card, 'dup')
    const withDup = rebuildState([record, record])
    const without = rebuildState([record])
    assert.equal(withDup.cards.size, without.cards.size)
    assert.deepEqual(getCard(withDup, 'a'), getCard(without, 'a'))
  })
})

describe('未知枚举值不静默降级（前向兼容）', () => {
  it('未知 kind 经真实重放后原样保留，不被改成 fact', () => {
    // 构造一条「未来版本写入的」put 记录：`kind:'summary'` 当前代码不认识。
    // 走 applyRecord 真实重放路径，不手搓状态。
    const state = createEmptyState()
    // 刻意绕过类型系统：`kind:'summary'` 不在 `MemoryKind` 里，这正是要测的场景。
    // 日志是外部输入（可能是更新版本写的），运行时不保证符合当前联合类型。
    const raw = { ...makeCard({ id: 'a' }), kind: 'summary' }
    applyRecord(state, makeRecord(1, { op: 'put', card: raw as unknown as MemoryCard }))
    const card = getCard(state, 'a')
    // 静默降级会让日志写 A、重放得 B，同一条日志两种结果，破坏 ST-1 且事后无从发现。
    assert.equal(card?.kind, 'summary', '未知 kind 必须原样透传，不能降级成 fact')
  })

  it('未知 domain 经真实重放后原样保留，不被改成 work', () => {
    const state = createEmptyState()
    const raw = { ...makeCard({ id: 'a' }), domain: 'hobby' }
    applyRecord(state, makeRecord(1, { op: 'put', card: raw as unknown as MemoryCard }))
    assert.equal(getCard(state, 'a')?.domain, 'hobby', '未知 domain 必须原样透传')
  })

  it('所有 MEMORY_KINDS 都能写入并重放往返', () => {
    // 这条测试的价值：以后给 MemoryKind 加值时自动覆盖，不需要有人记得改白名单。
    const state = createEmptyState()
    MEMORY_KINDS.forEach((kind, index) => {
      applyRecord(state, putRecord(index + 1, makeCard({ id: `k-${kind}`, kind })))
    })
    for (const kind of MEMORY_KINDS) {
      assert.equal(getCard(state, `k-${kind}`)?.kind, kind, `kind=${kind} 往返后应保持不变`)
    }
  })

  it('所有 MEMORY_DOMAINS 都能写入并重放往返', () => {
    const state = createEmptyState()
    MEMORY_DOMAINS.forEach((domain, index) => {
      applyRecord(state, putRecord(index + 1, makeCard({ id: `d-${domain}`, domain })))
    })
    for (const domain of MEMORY_DOMAINS) {
      assert.equal(getCard(state, `d-${domain}`)?.domain, domain, `domain=${domain} 往返后应保持不变`)
    }
  })

  it('缺失 kind 时才兜底成 fact（无信息可保留）', () => {
    const state = createEmptyState()
    const raw: Record<string, unknown> = { ...makeCard({ id: 'a' }) }
    delete raw['kind']
    applyRecord(state, makeRecord(1, { op: 'put', card: raw as unknown as MemoryCard }))
    assert.equal(getCard(state, 'a')?.kind, 'fact')
  })
})

describe('纯函数式应用', () => {
  it('applyRecordPure 不应修改原状态', () => {
    const state = createEmptyState()
    const card = makeCard({ id: 'a' })
    applyRecord(state, putRecord(1, card))
    const next = applyRecordPure(state, makeRecord(2, { op: 'archive', id: 'a', at: 2, reason: 'r' }))
    assert.equal(getCard(state, 'a')?.status, 'active')
    assert.equal(getCard(next, 'a')?.status, 'archived')
  })

  it('cloneState 应是深拷贝，改副本不影响原状态', () => {
    const state = createEmptyState()
    const card = makeCard({ id: 'a', tags: ['x'] })
    applyRecord(state, putRecord(1, card))
    const copy = cloneState(state)
    const copyCard = copy.cards.get('a')
    copyCard?.tags.push('y')
    assert.deepEqual(getCard(state, 'a')?.tags, ['x'])
  })
})

describe('查询', () => {
  it('按域与类型过滤', () => {
    const state = createEmptyState()
    applyRecord(state, putRecord(1, makeCard({ id: 'a', domain: 'work', kind: 'fact' })))
    applyRecord(state, putRecord(2, makeCard({ id: 'b', domain: 'life', kind: 'feeling' })))
    assert.deepEqual(filterCards(state, { domain: 'work' }).map((item) => item.id), ['a'])
    assert.deepEqual(filterCards(state, { kind: 'feeling' }).map((item) => item.id), ['b'])
  })

  it('默认包含已合并卡片，显式关闭后应排除', () => {
    const state = createEmptyState()
    applyRecord(state, putRecord(1, makeCard({ id: 'a', mergedInto: 'x' })))
    assert.equal(filterCards(state).length, 1)
    assert.equal(filterCards(state, { includeMerged: false }).length, 0)
  })

  it('结果顺序固定为 updatedAt 降序、id 升序', () => {
    const state = createEmptyState()
    applyRecord(state, putRecord(1, makeCard({ id: 'b', updatedAt: 10 })))
    applyRecord(state, putRecord(2, makeCard({ id: 'a', updatedAt: 10 })))
    applyRecord(state, putRecord(3, makeCard({ id: 'c', updatedAt: 20 })))
    assert.deepEqual(filterCards(state).map((item) => item.id), ['c', 'a', 'b'])
  })

  it('按时间区间与标签过滤', () => {
    const state = createEmptyState()
    applyRecord(state, putRecord(1, makeCard({ id: 'a', createdAt: 100, tags: ['qt'] })))
    applyRecord(state, putRecord(2, makeCard({ id: 'b', createdAt: 200, tags: ['ts'] })))
    assert.deepEqual(filterCards(state, { since: 150 }).map((item) => item.id), ['b'])
    assert.deepEqual(filterCards(state, { until: 150 }).map((item) => item.id), ['a'])
    assert.deepEqual(filterCards(state, { tag: 'ts' }).map((item) => item.id), ['b'])
  })
})
