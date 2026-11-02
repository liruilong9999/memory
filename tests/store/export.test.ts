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
import type { MemoryEdge } from '../../src/core/types.ts'
import {
  EXPORT_FORMAT_VERSION, exportJsonl, importJsonl, validateImport,
} from '../../src/store/export.ts'
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
