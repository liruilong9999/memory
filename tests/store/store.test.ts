/**
 * 门面单测：写入、重开重放、幂等、索引同步、导出。
 *
 * 对应需求：FR-A1/A2/A3/A6/A7、ST-1、ST-2、ST-8。
 *
 * @module tests/store/store.test
 */

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { buildEdgeId } from '../../src/core/types.ts'
import type { MemoryEdge } from '../../src/core/types.ts'
import { MemoryStore, deriveIdempotencyKey, openStore } from '../../src/store/store.ts'
import { makeCard, makeConfig, makeSource, makeTempDir, removeDirContents } from './helpers.ts'

const tempDirs: string[] = []

/** 建临时目录并登记。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-store-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/** 造一条边。 */
function makeEdge(from: string, to: string): MemoryEdge {
  return {
    id: buildEdgeId(from, to, 'same-topic'),
    from,
    to,
    relation: 'same-topic',
    weight: 0.7,
    createdAt: 1_700_000_000_000,
  }
}

describe('打开与写入', () => {
  it('写入后应能按 id 取回卡片', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    const card = makeCard()
    const result = store.putCard(card)
    assert.equal(result.written, true)
    assert.deepEqual(store.getCard(card.id), card)
    assert.equal(store.count(), 1)
    store.close()
  })

  it('打开时应自动创建数据目录并落盘日志', () => {
    const dir = tempDir()
    const store = openStore({ config: makeConfig(), dataDir: dir })
    store.putCard(makeCard())
    store.close()
    const files = readdirSync(dir)
    assert.ok(files.some((name) => name.startsWith('journal-')), `应产生日志分片，实际为 ${files.join(',')}`)
  })

  it('未显式 open 时首次写入也应可用（懒打开）', () => {
    const store = new MemoryStore({ config: makeConfig(), dataDir: tempDir() })
    const card = makeCard()
    store.putCard(card)
    assert.equal(store.count(), 1)
    store.close()
  })

  it('不存在的卡片应返回 undefined', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    assert.equal(store.getCard('ghost'), undefined)
    store.close()
  })
})

describe('幂等（FR-A2 / ST-2）', () => {
  it('同样的卡片写入两次应只留一条', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    const card = makeCard()
    const first = store.putCard(card)
    const second = store.putCard(card)
    assert.equal(first.written, true)
    assert.equal(second.written, false)
    assert.equal(store.count(), 1)
    store.close()
  })

  it('显式幂等键重复时应被丢弃', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    const card = makeCard()
    const first = store.append({ op: 'put', card }, 'explicit-key')
    const second = store.append({ op: 'put', card }, 'explicit-key')
    assert.equal(first.written, true)
    assert.equal(second.written, false)
    store.close()
  })

  it('重复导入同一批卡片，库中卡片数不变（ST-2）', () => {
    const dir = tempDir()
    const cards = [makeCard({ id: 'a' }), makeCard({ id: 'b' }), makeCard({ id: 'c' })]
    const store = openStore({ config: makeConfig(), dataDir: dir })
    for (const card of cards) store.putCard(card)
    for (const card of cards) store.putCard(card)
    assert.equal(store.count(), 3)
    store.close()

    // 重开再导入一次，仍然不应增长。
    const reopened = openStore({ config: makeConfig(), dataDir: dir })
    for (const card of cards) reopened.putCard(card)
    assert.equal(reopened.count(), 3)
    reopened.close()
  })
})

describe('重开与重放（ST-1 重启一致）', () => {
  it('关闭重开后卡片应完整还原', () => {
    const dir = tempDir()
    const card = makeCard({ text: '重启前写入的结论' })
    const first = openStore({ config: makeConfig(), dataDir: dir })
    first.putCard(card)
    first.close()

    const second = openStore({ config: makeConfig(), dataDir: dir })
    assert.deepEqual(second.getCard(card.id), card)
    assert.equal(second.count(), 1)
    second.close()
  })

  it('修正历史与归档状态应一并还原', () => {
    const dir = tempDir()
    const card = makeCard({ id: 'a', text: '旧结论' })
    const first = openStore({ config: makeConfig(), dataDir: dir })
    first.putCard(card)
    first.append({ op: 'revise', id: 'a', text: '新结论', normalized: '新结论', reason: '用户纠正', at: 2, actor: 'manual' })
    first.append({ op: 'archive', id: 'a', at: 3, reason: '低强度' })
    first.close()

    const second = openStore({ config: makeConfig(), dataDir: dir })
    const restored = second.getCard('a')
    assert.equal(restored?.text, '新结论')
    assert.equal(restored?.revisions.length, 1)
    assert.equal(restored?.status, 'archived')
    second.close()
  })

  it('重放 10 次得到完全相同的结果（ST-1）', () => {
    const dir = tempDir()
    const seed = openStore({ config: makeConfig(), dataDir: dir })
    seed.putCard(makeCard({ id: 'a', text: '甲' }))
    seed.putCard(makeCard({ id: 'b', text: '乙' }))
    seed.append({ op: 'touch', id: 'a', at: 5, strength: 0.55 })
    seed.close()

    const snapshots: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const store = openStore({ config: makeConfig(), dataDir: dir })
      snapshots.push(JSON.stringify(store.listCards()))
      store.close()
    }
    const baseline = snapshots[0]
    assert.ok(baseline !== undefined)
    for (const snapshot of snapshots) assert.equal(snapshot, baseline)
  })

  it('图谱边应随日志一并还原', () => {
    const dir = tempDir()
    const first = openStore({ config: makeConfig(), dataDir: dir })
    first.putCard(makeCard({ id: 'a' }))
    first.putCard(makeCard({ id: 'b' }))
    const edge = makeEdge('a', 'b')
    first.putEdge(edge)
    first.close()

    const second = openStore({ config: makeConfig(), dataDir: dir })
    assert.deepEqual(second.edgesOf('a').map((item) => item.id), [edge.id])
    second.close()
  })
})

describe('索引同步（FR-A7）', () => {
  it('写入后应立刻可检索到', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a', text: '部署失败了', normalized: '部署失败了' }))
    const hits = store.searchText('部署')
    assert.deepEqual(hits.map((item) => item.id), ['a'])
    store.close()
  })

  it('重开后索引应从卡片重建且保持一致', () => {
    const dir = tempDir()
    const first = openStore({ config: makeConfig(), dataDir: dir })
    first.putCard(makeCard({ id: 'a', text: '部署失败了', normalized: '部署失败了' }))
    first.close()

    const second = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(second.isIndexHealthy(), true)
    assert.equal(second.searchText('部署').length, 1)
    second.close()
  })

  it('修正后检索应命中新文本而非旧文本', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a', text: '部署失败了', normalized: '部署失败了' }))
    store.append({ op: 'revise', id: 'a', text: '回滚方案', normalized: '回滚方案', reason: '纠正', at: 2, actor: 'manual' })
    assert.deepEqual(store.searchText('部署'), [])
    assert.equal(store.searchText('回滚').length, 1)
    store.close()
  })

  it('purge 后卡片应从索引消失', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a', text: '部署失败了', normalized: '部署失败了' }))
    store.append({ op: 'purge', id: 'a', at: 2 })
    assert.deepEqual(store.searchText('部署'), [])
    assert.equal(store.isIndexHealthy(), true)
    store.close()
  })

  it('rebuildIndex 应返回统计且重建后保持一致', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a', text: '部署失败了', normalized: '部署失败了' }))
    const stats = store.rebuildIndex()
    assert.equal(stats.cards, 1)
    assert.ok(stats.terms > 0)
    assert.equal(store.isIndexHealthy(), true)
    store.close()
  })

  it('search 应受 candidateLimit 约束', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    for (let i = 0; i < 5; i += 1) {
      store.putCard(makeCard({ id: `c${i}`, text: '部署失败', normalized: '部署失败' }))
    }
    assert.equal(store.searchText('部署').length, 5)
    assert.equal(store.searchText('部署', 2).length, 2)
    store.close()
  })
})

describe('查询与列表', () => {
  it('listCards 应支持域与状态过滤', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a', domain: 'work' }))
    store.putCard(makeCard({ id: 'b', domain: 'life' }))
    assert.deepEqual(store.listCards({ domain: 'work' }).map((item) => item.id), ['a'])
    assert.equal(store.count('active'), 2)
    store.close()
  })

  it('状态快照应可读取卡片表', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a' }))
    assert.equal(store.snapshot().cards.size, 1)
    assert.equal(store.indexSnapshot().size, 1)
    store.close()
  })
})

describe('记录监听（FR-F1）', () => {
  it('每次真正写入应触发一次监听', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    const seen: string[] = []
    const off = store.onRecord((record) => seen.push(record.idempotencyKey))
    store.putCard(makeCard({ id: 'a' }))
    store.putCard(makeCard({ id: 'a' }))
    assert.equal(seen.length, 1)
    off()
    store.putCard(makeCard({ id: 'b' }))
    assert.equal(seen.length, 1)
    store.close()
  })
})

describe('导出（FR-A6 / ST-8）', () => {
  it('导出内容应包含全部卡片与边', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a' }))
    store.putCard(makeCard({ id: 'b' }))
    store.putEdge(makeEdge('a', 'b'))
    const text = store.exportJsonl(0)
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 4)
    assert.ok(text.includes('"kind":"header"'))
    store.close()
  })
})

describe('幂等键派生', () => {
  it('同样的操作应派生出同样的键', () => {
    const card = makeCard({ id: 'a' })
    assert.equal(
      deriveIdempotencyKey({ op: 'put', card }),
      deriveIdempotencyKey({ op: 'put', card }),
    )
  })

  it('不同操作应派生出不同的键', () => {
    assert.notEqual(
      deriveIdempotencyKey({ op: 'archive', id: 'a', at: 1, reason: 'r' }),
      deriveIdempotencyKey({ op: 'restore', id: 'a', at: 1 }),
    )
  })

  it('同一张卡内容变了必须能落盘（回归：幂等键只看 id 会静默丢弃更新）', () => {
    // 真实缺陷：put 的幂等键曾只按 card.id 派生，导致同一张卡的后续更新
    // （冲突标记回写、强度调整、状态变更）全被判成重复提交而丢弃。
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    const card = makeCard({ id: 'a', text: '原始文本' })
    assert.equal(store.putCard(card).written, true)

    const updated = { ...card, text: '改过的文本', updatedAt: card.updatedAt + 1000 }
    assert.equal(store.putCard(updated).written, true, '内容变化应写入成功')
    assert.equal(store.getCard('a')?.text, '改过的文本')
    store.close()
  })

  it('同一张卡完全相同的重复提交仍然幂等（ST-2）', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    const card = makeCard({ id: 'a' })
    assert.equal(store.putCard(card).written, true)
    assert.equal(store.putCard({ ...card }).written, false, '内容完全相同的重复提交应被跳过')
    assert.equal(store.count('active'), 1)
    store.close()
  })

  it('conflictOf 变化应产生新的幂等键', () => {
    const card = makeCard({ id: 'a' })
    const withConflict = { ...card, conflictOf: ['b'] }
    assert.notEqual(
      deriveIdempotencyKey({ op: 'put', card }),
      deriveIdempotencyKey({ op: 'put', card: withConflict }),
    )
  })

  it('putEdge 应自动补齐边 id 并幂等', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a' }))
    store.putCard(makeCard({ id: 'b' }))
    const first = store.putEdge({ ...makeEdge('a', 'b'), id: '' })
    const second = store.putEdge({ ...makeEdge('a', 'b'), id: '' })
    assert.equal(first.written, true)
    assert.equal(second.written, false)
    store.close()
  })
})

describe('来源指针（FR-A4 / ST-4）', () => {
  it('随机抽取的卡片都应带完整来源指针', () => {
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    for (let i = 0; i < 20; i += 1) {
      store.putCard(makeCard({
        id: `c${i}`,
        source: makeSource({ sessionId: `s${i}`, turn: i + 1, step: 1, seq: i + 1 }),
      }))
    }
    for (const card of store.listCards()) {
      assert.ok(card.source.sessionId.length > 0)
      assert.ok(card.source.seq > 0)
      assert.ok(card.source.eventType.length > 0)
    }
    store.close()
  })
})
