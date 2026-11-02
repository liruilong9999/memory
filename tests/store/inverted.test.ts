/**
 * 倒排索引单测：构建、查询、增量更新、重建与一致性检查。
 *
 * 对应需求：FR-A7（索引可重建）、NFR-1（性能）、ST-1（确定性）。
 *
 * @module tests/store/inverted.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { MemoryCard } from '../../src/core/types.ts'
import {
  addToIndex, buildIndex, buildIndexFromMap, collectTerms, indexStats, isIndexConsistent,
  removeFromIndex, searchIndex, searchText,
} from '../../src/store/inverted.ts'
import { makeCard } from './helpers.ts'

/** 造一张带明确文本的卡。 */
function card(id: string, text: string, extra: Partial<MemoryCard> = {}): MemoryCard {
  return makeCard({ id, text, normalized: text, ...extra })
}

describe('构建索引', () => {
  it('应按词项建倒排，同一词项指向多张卡', () => {
    const index = buildIndex([card('a', '部署失败'), card('b', '部署成功')])
    const bucket = index.postings.get('部署')
    assert.ok(bucket !== undefined)
    assert.deepEqual([...bucket].sort(), ['a', 'b'])
  })

  it('标签与实体也应进入索引', () => {
    const index = buildIndex([card('a', '内容', { tags: ['qt5'], entities: ['QtCreator'] })])
    assert.ok(index.postings.has('qt5'))
    assert.ok(index.documents.get('a')?.has('qtcreator'))
  })

  it('同一张卡重复出现只索引一次', () => {
    const c = card('a', '部署失败')
    const index = buildIndex([c, c])
    assert.equal(index.size, 1)
    assert.equal(index.documents.size, 1)
  })

  it('空输入应得到空索引', () => {
    const index = buildIndex([])
    assert.equal(index.size, 0)
    assert.equal(index.postings.size, 0)
  })

  it('builtAt 默认应为 0，保证纯函数可复现', () => {
    assert.equal(buildIndex([card('a', 'x')]).builtAt, 0)
    assert.equal(buildIndex([card('a', 'x')], 42).builtAt, 42)
  })

  it('buildIndexFromMap 与 buildIndex 结果一致', () => {
    const cards = [card('a', '部署失败'), card('b', '回滚方案')]
    const fromArray = buildIndex(cards)
    const fromMap = buildIndexFromMap(new Map(cards.map((item) => [item.id, item])))
    assert.deepEqual([...fromArray.postings.keys()].sort(), [...fromMap.postings.keys()].sort())
    assert.equal(fromArray.size, fromMap.size)
  })
})

describe('查询', () => {
  it('命中数应为查询词项与文档的交集大小', () => {
    // 中文按二元组（bigram）切分：「部署失败」的词项是「部署」「署失」。
    const index = buildIndex([card('a', '部署失败'), card('b', '部署成功')])
    const hits = searchIndex(index, ['部署', '署失'])
    const hitA = hits.find((item) => item.id === 'a')
    const hitB = hits.find((item) => item.id === 'b')
    assert.equal(hitA?.hits, 2)
    assert.equal(hitB?.hits, 1)
  })

  it('结果按命中数降序、id 升序排列（ST-1）', () => {
    const index = buildIndex([
      card('c', '部署'),
      card('a', '部署失败'),
      card('b', '部署成功'),
    ])
    const hits = searchIndex(index, ['部署'])
    assert.deepEqual(hits.map((item) => item.id), ['a', 'b', 'c'])
  })

  it('查询词项全不命中应返回空数组', () => {
    const index = buildIndex([card('a', '部署失败')])
    assert.deepEqual(searchIndex(index, ['完全无关的词汇']), [])
  })

  it('limit 应截断候选池', () => {
    const index = buildIndex([card('a', '部署'), card('b', '部署'), card('c', '部署')])
    assert.equal(searchIndex(index, ['部署'], 2).length, 2)
    assert.equal(searchIndex(index, ['部署'], 0).length, 0)
  })

  it('searchText 应自动归一化并分词', () => {
    const index = buildIndex([card('a', '部署失败了')])
    assert.equal(searchText(index, '部署').length, 1)
    assert.equal(searchText(index, '完全无关').length, 0)
  })

  it('同一查询 10 次结果完全一致（ST-1）', () => {
    const index = buildIndex([card('a', '部署失败'), card('b', '部署成功'), card('c', '部署方案')])
    const baseline = JSON.stringify(searchIndex(index, ['部署']))
    for (let i = 0; i < 10; i += 1) {
      assert.equal(JSON.stringify(searchIndex(index, ['部署'])), baseline)
    }
  })
})

describe('增量更新', () => {
  it('新增卡片后应可被检索到', () => {
    const index = buildIndex([card('a', '部署失败')])
    const next = addToIndex(index, card('b', '回滚方案'))
    assert.equal(next.size, 2)
    assert.equal(searchText(next, '回滚').length, 1)
  })

  it('增量更新不应修改原索引', () => {
    const index = buildIndex([card('a', '部署失败')])
    addToIndex(index, card('b', '回滚方案'))
    assert.equal(index.size, 1)
  })

  it('同 id 覆盖写应摘掉旧词项，不留幽灵命中', () => {
    const index = buildIndex([card('a', '部署失败')])
    const next = addToIndex(index, card('a', '回滚方案'))
    assert.equal(next.size, 1)
    assert.deepEqual(searchText(next, '部署'), [])
    assert.equal(searchText(next, '回滚').length, 1)
  })

  it('删除卡片后应不再被检索到', () => {
    const index = buildIndex([card('a', '部署失败'), card('b', '部署成功')])
    const next = removeFromIndex(index, 'a')
    assert.equal(next.size, 1)
    assert.deepEqual(searchText(next, '署失'), [])
    assert.equal(searchText(next, '部署').length, 1)
  })

  it('删除空桶应从词项表里移除', () => {
    const index = buildIndex([card('a', '独一无二的词')])
    const next = removeFromIndex(index, 'a')
    assert.equal(next.postings.size, 0)
  })

  it('删除不存在的卡片应原样返回', () => {
    const index = buildIndex([card('a', '部署失败')])
    assert.equal(removeFromIndex(index, 'ghost'), index)
  })
})

describe('可重建性（FR-A7）', () => {
  it('丢弃索引后从卡片重建应得到等价结果', () => {
    const cards = [card('a', '部署失败'), card('b', '回滚方案'), card('c', '架构约定')]
    const index = buildIndex(cards)
    // 模拟「索引丢了」：直接重新构建。
    const rebuilt = buildIndex(cards)
    assert.deepEqual(
      [...index.postings.keys()].sort(),
      [...rebuilt.postings.keys()].sort(),
    )
    assert.deepEqual(searchIndex(index, ['部署']), searchIndex(rebuilt, ['部署']))
  })

  it('增量维护的索引应与全量重建一致', () => {
    const a = card('a', '部署失败')
    const b = card('b', '回滚方案')
    const incremental = addToIndex(buildIndex([a]), b)
    const rebuilt = buildIndex([a, b])
    assert.deepEqual(
      [...incremental.postings.keys()].sort(),
      [...rebuilt.postings.keys()].sort(),
    )
    for (const key of rebuilt.postings.keys()) {
      assert.deepEqual(
        [...(incremental.postings.get(key) ?? [])].sort(),
        [...(rebuilt.postings.get(key) ?? [])].sort(),
      )
    }
  })
})

describe('一致性检查', () => {
  it('索引与卡片集合一致时应返回 true', () => {
    const cards = [card('a', '部署失败'), card('b', '回滚方案')]
    const index = buildIndex(cards)
    assert.equal(isIndexConsistent(index, new Map(cards.map((item) => [item.id, item]))), true)
  })

  it('卡片集合多一张时应返回 false', () => {
    const cards = [card('a', '部署失败')]
    const index = buildIndex(cards)
    const more = new Map([...cards, card('b', '回滚')].map((item) => [item.id, item]))
    assert.equal(isIndexConsistent(index, more), false)
  })

  it('卡片集合少一张时应返回 false', () => {
    const cards = [card('a', '部署失败'), card('b', '回滚')]
    const index = buildIndex(cards)
    assert.equal(isIndexConsistent(index, new Map([['a', cards[0]!]])), false)
  })
})

describe('统计与词项收集', () => {
  it('indexStats 应给出词项数与卡片数', () => {
    const index = buildIndex([card('a', '部署失败')])
    const stats = indexStats(index)
    assert.equal(stats.cards, 1)
    assert.ok(stats.terms > 0)
  })

  it('collectTerms 应包含文本、标签与实体词项', () => {
    const terms = collectTerms(card('a', '部署失败', { tags: ['qt5'], entities: ['QtCreator'] }))
    assert.ok(terms.has('部署'))
    assert.ok(terms.has('qt5'))
    assert.ok(terms.has('qtcreator'))
  })
})
