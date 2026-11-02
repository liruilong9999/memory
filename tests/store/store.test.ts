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
import { ConcurrentWriterError, ReadOnlyModeError } from '../../src/store/journal.ts'
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

  it('putEdge 改边权必须能落盘（回归：幂等键只看 id 会静默丢弃更新）', () => {
    // 这是 FR-G1 突触可塑性暴露出来的真缺陷，必须留一条测试守住。
    //
    // 缺陷：`deriveIdempotencyKey` 的 `edge` 分支原来只取 `op.edge.id`，
    // 不含权重。于是「用同一个 id 改权重」派生出的幂等键与上次完全相同，
    // 数据面判定为重复、**静默丢弃**，读回来还是旧值。
    // 探针实测：写 0.33，再用同 id 写 0.38，`allEdges()` 读回 0.33。
    //
    // 为什么长期没被发现：`edge` 的产出点只有夜整理，而夜整理只**新建**边、
    // 从不修改已有边（它用 `knownEdgeIds` 过滤掉已存在的），所以「幂等键不含
    // 权重」在当时的调用模式下永远正确。直到可塑性需要改边权，前提才失效。
    //
    // 上面那条用例为什么没抓到：它只用**同一权重**写两次，验证的是「重复被丢弃」，
    // 而缺陷恰恰在「不同权重也被当成重复」。**只测「该丢弃的丢弃」、
    // 不测「该更新的更新」，缺陷就能从中间溜过去。**
    const store = openStore({ config: makeConfig(), dataDir: tempDir() })
    store.putCard(makeCard({ id: 'a' }))
    store.putCard(makeCard({ id: 'b' }))
    const base = { ...makeEdge('a', 'b'), id: 'e-fixed' }

    const first = store.putEdge({ ...base, weight: 0.33 })
    assert.equal(first.written, true, '前提：第一次写入必须成功')
    assert.equal(store.edgesOf('a')[0]?.weight, 0.33, '前提：第一次权重必须读得回来')

    const second = store.putEdge({ ...base, weight: 0.38 })
    assert.equal(second.written, true, '改权重必须是新记录，不能被当成重复丢弃')
    assert.equal(store.edgesOf('a')[0]?.weight, 0.38, '改权重后必须读回新值')

    // 而「同 id 同权重」仍然必须幂等——修缺陷不能把 ST-2 一起弄坏。
    const third = store.putEdge({ ...base, weight: 0.38 })
    assert.equal(third.written, false, '同 id 同权重仍须幂等（ST-2）')
    store.close()
  })

  it('改边权后重开库仍读到新权重（重放一致，ST-1）', () => {
    // 上一条验证的是内存视图。幂等键影响的是**日志里有没有这条记录**，
    // 所以必须重开一次，从磁盘重放来证明「新记录真的写进去了」。
    // 若幂等键仍然不含权重，日志里就只有一条 edge 记录，重开后读回 0.33。
    const dir = tempDir()
    const store = openStore({ config: makeConfig(), dataDir: dir })
    store.putCard(makeCard({ id: 'a' }))
    store.putCard(makeCard({ id: 'b' }))
    const base = { ...makeEdge('a', 'b'), id: 'e-replay' }
    store.putEdge({ ...base, weight: 0.33 })
    store.putEdge({ ...base, weight: 0.38 })
    store.close()

    const reopened = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(reopened.edgesOf('a')[0]?.weight, 0.38, '重放后必须是最新权重')
    reopened.close()
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

/**
 * 多写者保护在门面层的生效情况（D-08）。
 *
 * `journal.test.ts` 测的是底层原语；这里补门面层，因为真实事故形态是
 * 「插件与 CLI 各持一个 `MemoryStore`」，而不是各持一个裸 `Journal`。
 *
 * ## 一个必须写下来的坑：危险序列是「两个都先 open，再各自写」
 *
 * 我第一版探针把场景写成「插件先写 → CLI 后开 → CLI 写」，断言 CLI 应被拒绝，
 * 结果红了。查下去是**探针错了**：CLI 打开时水位已与磁盘一致，它写的下一个
 * `seq` 是**合法**的，日志仍自洽（1, 2）。B 不该拦，也不该为拦它而拦。
 *
 * 真正危险的是「两个都先 open」：两边水位都是 0，各写一条就得到 `1, 1`。
 * 所以下面把两种情形**成对**测出来——只有「该拦的拦住了」而没有
 * 「不该拦的没拦」，B 就可能退化成「一律拒绝第二个实例」，把正常用法也废掉。
 */
describe('多写者保护（D-08）', () => {
  it('两个实例都先打开时，后写的一方应被拒绝且不落盘', () => {
    const dir = tempDir()
    const plugin = openStore({ config: makeConfig(), dataDir: dir })
    const cli = openStore({ config: makeConfig(), dataDir: dir })
    // 前提：两者打开时都还是空库，水位都是 0——这才是「会撞 seq」的起点。
    assert.equal(plugin.count(), 0, '前提：plugin 打开时库为空')
    assert.equal(cli.count(), 0, '前提：cli 打开时库也为空')

    plugin.putCard(makeCard({ id: 'a' }))
    assert.equal(plugin.count(), 1, '前提：plugin 确实写成功了')

    assert.throws(
      () => cli.putCard(makeCard({ id: 'b' })),
      (error: unknown) => error instanceof ConcurrentWriterError && error.code === 'MEMORY_CONCURRENT_WRITER',
      '落后的一方写入应被拒绝',
    )
    // 只断言「抛错了」不足以证明「没写坏」，必须查磁盘。
    const reader = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(reader.count(), 1, '被拒绝的写入不能在磁盘上留下痕迹')
    reader.close()
    cli.close()
    plugin.close()
  })

  it('后打开的实例首写是合法的，但会让先开的一方下次写入被拒绝', () => {
    const dir = tempDir()
    const plugin = openStore({ config: makeConfig(), dataDir: dir })
    plugin.putCard(makeCard({ id: 'a' }))          // seq 1
    const cli = openStore({ config: makeConfig(), dataDir: dir })  // 打开时读到 seq 1
    assert.equal(cli.count(), 1, '前提：cli 打开时读到了 plugin 写的那条')

    // cli 的水位与磁盘一致，seq 2 是合法的下一个序号，不该拦。
    cli.putCard(makeCard({ id: 'b' }))
    assert.equal(cli.count(), 2, '后开者首写应被允许，否则正常用法会被废掉')

    // 但 plugin 的内存水位已过期（以为 maxSeq=1，磁盘是 2），它的下一次写必须被拒。
    assert.throws(
      () => plugin.putCard(makeCard({ id: 'c' })),
      (error: unknown) => error instanceof ConcurrentWriterError,
      '水位过期的一方写入应被拒绝，否则会写出重复的 seq 2',
    )

    const reader = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(reader.count(), 2, '磁盘上应仍只有 2 条，没有重复序号的第 3 条')
    const seqs = reader.listCards().map((card) => card.id).sort()
    assert.deepEqual(seqs, ['a', 'b'])
    reader.close()
    cli.close()
    plugin.close()
  })

  it('只读与修复模式在门面层也应拒绝写入', () => {
    const dir = tempDir()
    const writer = openStore({ config: makeConfig(), dataDir: dir })
    writer.putCard(makeCard({ id: 'a' }))
    writer.close()

    for (const mode of ['readonly', 'repair'] as const) {
      const store = openStore({ config: makeConfig(), dataDir: dir, mode })
      // 前提：模式真的被记住了，而不是被默默忽略掉。
      assert.equal(store.mode, mode, `前提：store.mode 应为 ${mode}`)
      assert.equal(store.count(), 1, `${mode} 模式必须能读`)
      assert.throws(
        () => store.putCard(makeCard({ id: 'x' })),
        (error: unknown) => error instanceof ReadOnlyModeError && error.code === 'MEMORY_READONLY_MODE',
        `${mode} 模式必须拒绝写入`,
      )
      store.close()
    }

    // 默认模式必须是可写，否则宿主漏传 mode 会静默失去写能力。
    const defaulted = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(defaulted.mode, 'write', 'StoreOptions.mode 的默认值必须是 write')
    defaulted.close()
  })
})

/**
 * 进程内并发写入（任务卡 task-3 的 `Promise.all` 验收项）。
 *
 * ## 结论：进程内不需要写锁，因为 `append` 全程同步
 *
 * 实测 100 个 async 上下文同时触发 `append`（每个之间插 `await` 让出），
 * 磁盘上 100 条记录、序号 `1..100` 连续无重复、无空洞。
 *
 * 原因不是「运气好」或「概率低」，而是**结构性**的：`append` 从取
 * `lastSeq()` 到 `writeSync` 结束全程没有 `await`，JS 单线程下一个同步函数
 * 一旦开始就不可被抢占。所以「两个 async 上下文同时写」在进程内**不存在**
 * 交错窗口，加锁只会增加代码而不增加正确性。
 *
 * ## 那这条测试守什么
 *
 * 守的是**将来**：若有人把 `append` 改成 `async`（比如为了加 fsync 队列、
 * 或换成异步 IO），同步性这条隐含前提就没了，进程内交错立刻成为真实风险。
 * 那时这条测试会变红——**它守的不是当前行为，是一个会被悄悄破坏的前提**。
 *
 * 跨进程的真实风险不在这里，见上面的「多写者保护（D-08）」。
 */
describe('进程内并发写入', () => {
  it('多个 async 上下文同时写入不应产生重复序号或丢记录', async () => {
    const dir = tempDir()
    const store = openStore({ config: makeConfig(), dataDir: dir })
    const N = 100

    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        // 故意让出一个 microtask，给「交错」制造机会。同步实现下这不会改变结果，
        // 一旦实现变成异步，这里就会开始丢记录或撞序号。
        await Promise.resolve()
        store.putCard(makeCard({ id: `c${i}` }))
      }),
    )

    // 正向证据：先确认写入真的发生了。若 count 不是 N，下面「序号连续」的
    // 结论就没有意义——那可能只是一条都没写进去。
    assert.equal(store.count(), N, `前提：${N} 条记录必须全部写入`)
    assert.equal(store.snapshot().lastSeq, N, `序号水位应为 ${N}`)

    const seqs = store.listCards().length
    assert.equal(seqs, N)

    // 关掉重开，从磁盘读——内存里的 lastSeq 是自报的，磁盘才是证据。
    store.close()
    const reader = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(reader.count(), N, '重放后条数必须一致（无丢失）')
    assert.equal(reader.snapshot().lastSeq, N, '重放后序号水位必须一致（无重复）')
    reader.close()
  })
})
