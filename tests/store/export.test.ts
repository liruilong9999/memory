/**
 * 导出与重建单测：JSONL 往返无损、坏行容错、自洽校验。
 *
 * 对应需求：FR-A6（导出与重建）、ST-8（导出重建）。
 *
 * @module tests/store/export.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildEdgeId } from '../../src/core/types.ts'
import type { MemoryCard, MemoryEdge } from '../../src/core/types.ts'
import {
  EXPORT_FORMAT_VERSION, exportJsonl, importJsonl, validateImport,
} from '../../src/store/export.ts'
import type { ImportResult } from '../../src/store/export.ts'
import { makeCard } from './helpers.ts'

/** 造一条边。 */
function makeEdge(from: string, to: string): MemoryEdge {
  return {
    id: buildEdgeId(from, to, 'same-topic'),
    from,
    to,
    relation: 'same-topic',
    weight: 0.75,
    createdAt: 1_700_000_000_000,
  }
}

describe('导出格式', () => {
  it('第一行应是头，含版本号与条数', () => {
    const text = exportJsonl([makeCard({ id: 'a' })], [], 123)
    const first = text.split('\n')[0]
    assert.ok(first !== undefined)
    const header = JSON.parse(first)
    assert.equal(header.kind, 'header')
    assert.equal(header.v, EXPORT_FORMAT_VERSION)
    assert.equal(header.exportedAt, 123)
    assert.equal(header.cards, 1)
    assert.equal(header.edges, 0)
  })

  it('卡片与边应各占一行', () => {
    const text = exportJsonl([makeCard({ id: 'a' }), makeCard({ id: 'b' })], [makeEdge('a', 'b')])
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 4)
  })

  it('输出顺序应稳定：卡片与边均按 id 升序', () => {
    const cards = [makeCard({ id: 'c' }), makeCard({ id: 'a' }), makeCard({ id: 'b' })]
    const text = exportJsonl(cards, [])
    const ids = text.trim().split('\n').slice(1).map((line) => JSON.parse(line).card.id)
    assert.deepEqual(ids, ['a', 'b', 'c'])
  })

  it('同一输入两次导出应得到完全相同的文本', () => {
    const cards = [makeCard({ id: 'a' }), makeCard({ id: 'b' })]
    assert.equal(exportJsonl(cards, [], 0), exportJsonl(cards, [], 0))
  })

  it('空库导出应只有头行', () => {
    const text = exportJsonl([], [])
    assert.equal(text.trim().split('\n').length, 1)
  })
})

describe('导入', () => {
  it('导出的文本应能完整导入', () => {
    const cards = [makeCard({ id: 'a' }), makeCard({ id: 'b' })]
    const edges = [makeEdge('a', 'b')]
    const result = importJsonl(exportJsonl(cards, edges, 5))
    assert.equal(result.cards.length, 2)
    assert.equal(result.edges.length, 1)
    assert.equal(result.header?.exportedAt, 5)
    assert.equal(result.skipped, 0)
  })

  it('坏行应被跳过并计数，不影响其余行', () => {
    const good = JSON.stringify({ kind: 'card', card: makeCard({ id: 'a' }) })
    const text = `${good}\n{不是 JSON}\n\n{"kind":"card"}\n`
    const result = importJsonl(text)
    assert.equal(result.cards.length, 1)
    assert.equal(result.skipped, 2)
  })

  it('未知行类型应被跳过', () => {
    const result = importJsonl('{"kind":"unknown"}\n')
    assert.equal(result.skipped, 1)
    assert.equal(result.header, null)
  })

  it('缺少头行时 header 应为 null 但卡片仍能导入', () => {
    const line = JSON.stringify({ kind: 'card', card: makeCard({ id: 'a' }) })
    const result = importJsonl(line)
    assert.equal(result.header, null)
    assert.equal(result.cards.length, 1)
  })

  it('空文本应得到空结果', () => {
    const result = importJsonl('')
    assert.deepEqual(result.cards, [])
    assert.deepEqual(result.edges, [])
    assert.equal(result.skipped, 0)
  })
})

describe('往返无损（ST-8）', () => {
  it('卡片字段导出再导入应逐字段相等', () => {
    const cards = [
      makeCard({ id: 'a', tags: ['qt', 'cmake'], entities: ['Qt5', 'CMakeLists.txt'] }),
      makeCard({ id: 'b', status: 'archived', pinned: true, dueAt: 1_800_000_000_000 }),
      makeCard({
        id: 'c',
        revisions: [{ at: 1, reason: '纠正', previousText: '旧', actor: 'manual' }],
        conflictOf: ['a'],
        mergedInto: 'a',
        mergeOf: ['d'],
      }),
    ]
    const result = importJsonl(exportJsonl(cards, []))
    assert.deepEqual(result.cards, cards)
  })

  it('边字段导出再导入应逐字段相等', () => {
    const edges = [makeEdge('a', 'b')]
    const result = importJsonl(exportJsonl([makeCard({ id: 'a' }), makeCard({ id: 'b' })], edges))
    assert.deepEqual(result.edges, edges)
  })

  it('导出再导入再导出应得到相同文本（幂等）', () => {
    const cards = [makeCard({ id: 'a' }), makeCard({ id: 'b' })]
    const edges = [makeEdge('a', 'b')]
    const first = exportJsonl(cards, edges, 7)
    const imported = importJsonl(first)
    const second = exportJsonl(imported.cards, imported.edges, 7)
    assert.equal(second, first)
  })

  it('100 张卡抽查应全部一致（ST-8 的 100 条口径）', () => {
    const cards = Array.from({ length: 100 }, (_, index) => makeCard({
      id: `card-${String(index).padStart(3, '0')}`,
      text: `第 ${index} 条记忆`,
    }))
    const result = importJsonl(exportJsonl(cards, []))
    assert.equal(result.cards.length, 100)
    const byId = new Map(result.cards.map((item) => [item.id, item]))
    for (const card of cards) {
      assert.deepEqual(byId.get(card.id), card)
    }
  })

  it('特殊字符（换行、引号、emoji）应无损往返', () => {
    const card = makeCard({ id: 'weird', text: '第一行\n第二行 "引号" 🚀' })
    const result = importJsonl(exportJsonl([card], []))
    assert.equal(result.cards[0]?.text, card.text)
  })
})

describe('自洽校验', () => {
  it('自洽的导出应无错误', () => {
    const result = importJsonl(exportJsonl([makeCard({ id: 'a' }), makeCard({ id: 'b' })], [makeEdge('a', 'b')]))
    assert.deepEqual(validateImport(result), [])
  })

  it('重复卡片 id 应报错', () => {
    const card = makeCard({ id: 'a' })
    const result = importJsonl(exportJsonl([card, card], []))
    assert.equal(validateImport(result).length, 1)
  })

  it('悬空边应报错', () => {
    const result = importJsonl(exportJsonl([makeCard({ id: 'a' })], [makeEdge('a', 'ghost')]))
    const errors = validateImport(result)
    assert.equal(errors.length, 1)
    assert.ok(errors[0]?.includes('ghost'))
  })
})

/**
 * 把一张卡挖掉一个字段，得到「解析层认得、形状层不认」的卡片。
 *
 * 保留 `id`：解析层只按 id 收卡，没有 id 的会被算成坏行而根本进不了
 * `result.cards`——那样测的就不是形状判据，而是解析层的收卡条件。
 */
function without(card: MemoryCard, field: string): MemoryCard {
  const raw = { ...card } as unknown as Record<string, unknown>
  delete raw[field]
  return raw as unknown as MemoryCard
}

/** 手工拼一个导入结果；形状判据是纯函数，不需要真的经过 JSONL 文本。 */
function resultOf(cards: readonly MemoryCard[], edges: readonly MemoryEdge[] = []): ImportResult {
  return { cards: [...cards], edges: [...edges], header: null, skipped: 0 }
}

describe('导入预检：卡片与边的形状（缺陷 W8）', () => {
  // 这一组是预检层的**单元级**断言。CLI 那一侧（`tests/cli/import.test.ts`）
  // 证明端到端不写库，这里证明判据本身说了什么——只有端到端时，
  // 一个「把所有导入都拒掉」的实现也能让那些用例变绿。

  it('合法卡与合法边仍然零错误（防止新判据把正常文件也拒掉）', () => {
    const result = resultOf([makeCard({ id: 'a' }), makeCard({ id: 'b' })], [makeEdge('a', 'b')])
    assert.deepEqual(validateImport(result), [])
  })

  it('缺 conflictOf 报一条、且点名该字段', () => {
    const errors = validateImport(resultOf([without(makeCard({ id: 'a' }), 'conflictOf')]))
    assert.equal(errors.length, 1, `只应报一条，实际：${errors.join(' | ')}`)
    assert.match(errors[0] ?? '', /卡片 a 结构非法/u)
    assert.match(errors[0] ?? '', /conflictOf/u)
  })

  it('缺 strength / status / accessCount 各报一条（这些不会崩，所以更危险）', () => {
    // 只测 conflictOf 会给人「只有这个字段有问题」的错觉：其余字段缺失时
    // `String(undefined)` 兜住了，卡照样落盘，是**静默**的那种坏。
    for (const field of ['strength', 'status', 'accessCount', 'source', 'salience', 'tags']) {
      const errors = validateImport(resultOf([without(makeCard({ id: 'a' }), field)]))
      assert.equal(errors.length, 1, `缺 ${field} 应恰好一条错误，实际：${errors.join(' | ')}`)
      assert.match(errors[0] ?? '', new RegExp(field, 'u'), `错误必须点名 ${field}`)
    }
  })

  it('缺多个字段时合成一条，不逐字段刷屏', () => {
    // CLI 只打印前 5 条（`problems.slice(0, 5)`），若一张卡缺 5 个字段就占满
    // 整个窗口，用户看到的全是同一张卡，别的坏卡一条都看不见。
    const broken = without(without(makeCard({ id: 'a' }), 'conflictOf'), 'strength')
    const errors = validateImport(resultOf([broken]))
    assert.equal(errors.length, 1)
    assert.match(errors[0] ?? '', /缺少 2 个必填字段/u)
  })

  it('形状非法的卡片不会让同批的边被误报成悬空', () => {
    // 这条守的是 `validateImport` 里「即使形状非法也把 id 记进 inFile」那个决定。
    // 不这么做的话，用户会看到「卡片 a 结构非法」+「边 e 的起点 a 不存在」——
    // 第二句是假的（a 就在文件里），而**错误信息指错地方比少报一条更糟**：
    // 他会去修一条没问题的边。
    const broken = without(makeCard({ id: 'a' }), 'conflictOf')
    const errors = validateImport(resultOf([broken, makeCard({ id: 'b' })], [makeEdge('a', 'b')]))
    assert.equal(errors.length, 1, `只应报卡片那条，实际：${errors.join(' | ')}`)
    assert.match(errors[0] ?? '', /结构非法/u)
  })

  it('边缺 weight 报结构非法，且不叠加「端点不存在」', () => {
    // 重放层对边**完全不校验**（`applyRecord` 只判 id 非空就原样入状态），
    // 所以缺 weight 的边会以 `undefined` 参与打分，`a.weight * b.weight`
    // 得到 NaN，扩散加分整段污染且不报错。
    const edge = { ...makeEdge('a', 'b') } as unknown as Record<string, unknown>
    delete edge['weight']
    const errors = validateImport(resultOf([makeCard({ id: 'a' }), makeCard({ id: 'b' })], [edge as unknown as MemoryEdge]))
    assert.equal(errors.length, 1, `只应报一条，实际：${errors.join(' | ')}`)
    assert.match(errors[0] ?? '', /结构非法/u)
    assert.match(errors[0] ?? '', /weight/u)
  })

  it('边的 relation 不在七种之内时报错（未知值会让所有 switch 静默走 default）', () => {
    const edge = { ...makeEdge('a', 'b'), relation: 'made-up' } as unknown as MemoryEdge
    const errors = validateImport(resultOf([makeCard({ id: 'a' }), makeCard({ id: 'b' })], [edge]))
    assert.equal(errors.length, 1)
    assert.match(errors[0] ?? '', /relation/u)
  })

  it('卡片不是对象时用序号定位（拼 id 只会得到 [object Object]）', () => {
    const errors = validateImport(resultOf(['not-a-card' as unknown as MemoryCard]))
    assert.equal(errors.length, 1)
    assert.match(errors[0] ?? '', /第 1 张卡片/u)
    assert.match(errors[0] ?? '', /不是对象/u)
  })
})
