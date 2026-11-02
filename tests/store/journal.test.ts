/**
 * 事件日志单测：序列化、幂等、分片滚动、崩溃尾行修复。
 *
 * 对应需求：FR-A2（幂等）、FR-A3（原子性 / 崩溃恢复）、ST-2、ST-3。
 *
 * @module tests/store/journal.test
 */

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import type { JournalRecord } from '../../src/core/types.ts'
import {
  ConcurrentWriterError, Journal, ReadOnlyModeError, buildIdempotencyKey, decodeRecord,
  encodeRecord, listShardFiles, shardFileName,
} from '../../src/store/journal.ts'
import { makeCard, makeRecord, makeTempDir, removeDirContents } from './helpers.ts'

const tempDirs: string[] = []

/** 建临时目录并登记，测试结束统一清理。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-journal-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

describe('日志序列化', () => {
  it('编码后再解码应还原同一条记录', () => {
    const card = makeCard()
    const record = makeRecord(1, { op: 'put', card })
    const decoded = decodeRecord(encodeRecord(record))
    assert.deepEqual(decoded, record)
  })

  it('空行与非法 JSON 应解码为 null', () => {
    assert.equal(decodeRecord(''), null)
    assert.equal(decodeRecord('   '), null)
    assert.equal(decodeRecord('{'), null)
    assert.equal(decodeRecord('123'), null)
    assert.equal(decodeRecord('{"v":1}'), null)
  })

  it('版本号不是 1 的记录应被拒绝', () => {
    const line = JSON.stringify({ v: 2, seq: 1, at: 0, idempotencyKey: 'k', op: { op: 'purge', id: 'a', at: 0 } })
    assert.equal(decodeRecord(line), null)
  })

  it('未知操作标签应被拒绝', () => {
    const line = JSON.stringify({ v: 1, seq: 1, at: 0, idempotencyKey: 'k', op: { op: 'boom' } })
    assert.equal(decodeRecord(line), null)
  })
})

describe('分片文件名', () => {
  it('序号应补零到 6 位', () => {
    assert.equal(shardFileName(1), 'journal-000001.jsonl')
    assert.equal(shardFileName(42), 'journal-000042.jsonl')
  })

  it('非日志文件不参与分片列表', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, 'journal-000001.jsonl'), '')
    assert.deepEqual(listShardFiles(dir), ['journal-000001.jsonl'])
  })

  it('分片列表按序号升序而非字典序', () => {
    const dir = tempDir()
    for (const name of ['journal-000002.jsonl', 'journal-000010.jsonl', 'journal-000001.jsonl']) {
      writeFileSync(join(dir, name), '')
    }
    assert.deepEqual(listShardFiles(dir), [
      'journal-000001.jsonl', 'journal-000002.jsonl', 'journal-000010.jsonl',
    ])
  })
})

describe('追加与读取', () => {
  it('按追加顺序读回全部记录', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    for (let seq = 1; seq <= 5; seq += 1) {
      journal.append(makeRecord(seq, { op: 'put', card: makeCard({ text: `第 ${seq} 条` }) }))
    }
    const records = journal.readAll()
    assert.equal(records.length, 5)
    assert.deepEqual(records.map((item) => item.seq), [1, 2, 3, 4, 5])
    journal.close()
  })

  it('序号由日志统一分配，入参序号更小时也要递增', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    const first = journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 0 }, 'k-a'))
    const second = journal.append(makeRecord(1, { op: 'purge', id: 'b', at: 0 }, 'k-b'))
    assert.equal(first.record.seq, 1)
    assert.equal(second.record.seq, 2)
    assert.equal(journal.lastSeq(), 2)
    journal.close()
  })

  it('重复幂等键应被丢弃且不落盘', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    const card = makeCard()
    const record = makeRecord(1, { op: 'put', card }, 'same-key')
    const first = journal.append(record)
    const second = journal.append(makeRecord(2, { op: 'put', card }, 'same-key'))
    assert.equal(first.appended, true)
    assert.equal(second.appended, false)
    assert.equal(second.duplicateOfSeq, 1)
    assert.equal(journal.readAll().length, 1)
    assert.equal(journal.count(), 1)
    journal.close()
  })

  it('重复幂等键应能被 hasKey 查到', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 0 }, 'k1'))
    assert.equal(journal.hasKey('k1'), true)
    assert.equal(journal.hasKey('k2'), false)
    journal.close()
  })

  it('重新打开后幂等键集合与序号水位应恢复', () => {
    const dir = tempDir()
    const first = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    first.open()
    first.append(makeRecord(1, { op: 'purge', id: 'a', at: 0 }, 'k1'))
    first.append(makeRecord(2, { op: 'purge', id: 'b', at: 0 }, 'k2'))
    first.close()

    const second = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    second.open()
    assert.equal(second.lastSeq(), 2)
    assert.equal(second.hasKey('k1'), true)
    const again = second.append(makeRecord(9, { op: 'purge', id: 'c', at: 0 }, 'k1'))
    assert.equal(again.appended, false)
    const fresh = second.append(makeRecord(9, { op: 'purge', id: 'd', at: 0 }, 'k3'))
    assert.equal(fresh.record.seq, 3)
    second.close()
  })
})

describe('分片滚动', () => {
  it('超过单片大小后应滚动到新分片', () => {
    const dir = tempDir()
    // 单片上限压到很小，保证几条记录就会触发滚动。
    const journal = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    for (let seq = 1; seq <= 8; seq += 1) {
      journal.append(makeRecord(seq, { op: 'purge', id: `card-${seq}`, at: seq }))
    }
    const files = listShardFiles(dir)
    assert.ok(files.length > 1, `应产生多个分片，实际只有 ${files.length} 个`)
    assert.equal(files[0], 'journal-000001.jsonl')
    journal.close()
  })

  it('滚动后按分片顺序读回全部记录', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    for (let seq = 1; seq <= 10; seq += 1) {
      journal.append(makeRecord(seq, { op: 'purge', id: `card-${seq}`, at: seq }))
    }
    const records = journal.readAll()
    assert.equal(records.length, 10)
    assert.deepEqual(records.map((item) => item.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    journal.close()
  })

  it('单条记录超过单片上限时不应产生空分片', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 8, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    journal.append(makeRecord(1, { op: 'put', card: makeCard() }))
    journal.append(makeRecord(2, { op: 'put', card: makeCard({ text: '另一张很长的卡片内容' }) }))
    const files = listShardFiles(dir)
    // 每条都超过 8 字节，因此每片一条，不会出现「空片 + 数据片」的畸形布局。
    assert.equal(files.length, 2)
    assert.equal(journal.readAll().length, 2)
    journal.close()
  })

  it('重新打开后应接着最后一个分片继续写', () => {
    const dir = tempDir()
    const first = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false, mode: 'write' })
    first.open()
    for (let seq = 1; seq <= 6; seq += 1) {
      first.append(makeRecord(seq, { op: 'purge', id: `c${seq}`, at: seq }))
    }
    const shardCount = listShardFiles(dir).length
    first.close()

    const second = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false, mode: 'write' })
    second.open()
    second.append(makeRecord(7, { op: 'purge', id: 'c7', at: 7 }))
    assert.ok(listShardFiles(dir).length >= shardCount)
    assert.equal(second.readAll().length, 7)
    second.close()
  })
})

describe('崩溃恢复', () => {
  it('尾部残缺行应在打开时被截断', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 1 }, 'k1'))
    journal.close()

    // 模拟强杀：写入半条 JSON，没有换行结尾。
    appendFileSync(join(dir, shardFileName(1)), '{"v":1,"seq":2,"at":2,"idempo')

    const reopened = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    reopened.open()
    const records = reopened.readAll()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.seq, 1)
    // 修复后继续追加，新记录必须完整可读。
    reopened.append(makeRecord(2, { op: 'purge', id: 'b', at: 2 }, 'k2'))
    assert.equal(reopened.readAll().length, 2)
    reopened.close()
  })

  it('残缺行被截断后文件以换行结尾', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 1 }, 'k1'))
    journal.close()
    const path = join(dir, shardFileName(1))
    appendFileSync(path, '{"broken":true')
    const reopened = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    reopened.open()
    assert.ok(readFileSync(path, 'utf8').endsWith('\n'))
    reopened.close()
  })

  it('数据目录不存在时读取应返回空而不是抛错', () => {
    const dir = join(tempDir(), 'not-created-yet')
    assert.equal(existsSync(dir), false)
    assert.deepEqual(listShardFiles(dir), [])
  })

  it('打开的日志应自动创建数据目录', () => {
    const dir = join(tempDir(), 'nested', 'data')
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    assert.equal(existsSync(dir), true)
    journal.close()
  })
})

describe('幂等键派生', () => {
  it('同样的要素应得到同样的键', () => {
    assert.equal(buildIdempotencyKey('put', 'card-1'), buildIdempotencyKey('put', 'card-1'))
  })

  it('不同要素应得到不同的键', () => {
    assert.notEqual(buildIdempotencyKey('put', 'card-1'), buildIdempotencyKey('put', 'card-2'))
  })

  it('要素分隔应避免拼接歧义', () => {
    assert.notEqual(buildIdempotencyKey('ab', 'c'), buildIdempotencyKey('a', 'bc'))
  })
})

/**
 * 多写者并发（D-08）。
 *
 * 场景来源：`docs/2-DSH宿主约束.md` 里宿主可能并发，且 CLI 可以在插件运行中
 * 被另一个进程调用（运维查库、重建索引）。此时同一个数据目录上会同时存在
 * **两个 `Journal` 实例**，各自在 `open()` 时把 `maxSeq` 读进内存。
 *
 * ## 这三条用例原本是红的，它们记录的是三个真实故障
 *
 * 写成「两个实例交替追加、要求序号唯一」时全部为红，故障形态分别是
 * **序号重复（`1,1,2,2`）、幂等失效（同一键落盘两条）、跨分片重放顺序倒置
 * （最后写的记录重放在第 1 位）**。
 *
 * ## 修法不是让它们绿，而是换掉它们要的结论
 *
 * 真正的修法是**检测并拒绝第二个写者**，而不是让第二个写者「安全地并发写」——
 * 后者需要跨进程锁，Windows 上 `unlinkSync` 对已打开的 `wx` 句柄仍然成功，
 * 文件锁不构成内核级互斥，做不到。
 *
 * 所以三条用例的断言方向改为：**第二个写者必须被显式拒绝，且磁盘上不能留下
 * 任何损坏痕迹**。它们守的仍然是那三个故障，只是守的方式从「要求不出现」
 * 变成「出现时必须响亮失败」。
 *
 * 删掉这三条去换绿是不允许的：它们是这三个故障唯一的现场记录。
 */
describe('多写者并发（D-08）', () => {
  /**
   * 造一条最小的 touch 记录，只要幂等键不同即可。
   *
   * 返回类型必须显式标注为 `JournalRecord`：不标注时对象字面量的 `v: 1`
   * 会被拓宽成 `number`，而 `JournalRecord['v']` 是字面量类型 `1`，赋值不兼容。
   * 不用 `as const` 是因为它只治 `v` 这一个字段，将来往这里加字段还会再犯一次。
   */
  function touch(key: string, at = 1_700_000_000_000): JournalRecord {
    return { v: 1, seq: 0, at, idempotencyKey: key, op: { op: 'touch', id: key, at, strength: 0.5 } }
  }

  /** 直接读磁盘上的可解码记录，不经过任何内存水位——这是唯一可信的证据。 */
  function readDisk(dir: string): JournalRecord[] {
    const records: JournalRecord[] = []
    for (const file of listShardFiles(dir)) {
      const text = readFileSync(join(dir, file), 'utf8')
      for (const line of text.split('\n')) {
        const record = decodeRecord(line)
        if (record !== null) records.push(record)
      }
    }
    return records
  }

  /** 断言抛出的是并发冲突，且能被 `instanceof` 与 `code` 双重识别。 */
  function assertConcurrentWriter(fn: () => unknown, hint: string): ConcurrentWriterError {
    let caught: unknown
    try {
      fn()
    } catch (error) {
      caught = error
    }
    assert.ok(caught !== undefined, `${hint}：应当抛出并发写入错误，实际没有抛`)
    // 双通道识别：跨包 / 序列化场景下 `instanceof` 会失效，`code` 不会。
    assert.ok(caught instanceof ConcurrentWriterError, `${hint}：应能通过 instanceof 识别`)
    assert.equal((caught as ConcurrentWriterError).code, 'MEMORY_CONCURRENT_WRITER', `${hint}：code 应稳定`)
    return caught as ConcurrentWriterError
  }

  it('两个实例交替追加时序号必须唯一且单调（第二个写者被拒绝）', () => {
    const dir = tempDir()
    const a = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    const b = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    a.open()
    b.open()
    // a 先写一条，此后 b 的内存水位就落后于磁盘了。
    a.append(touch('k1'))
    assertConcurrentWriter(() => b.append(touch('k2')), 'b 落后于磁盘时写入')

    // 关键：b 的写入没有落盘。序号重复之所以危险，是因为它**静默**发生；
    // 拒绝写入之后，磁盘上必须只剩 a 写的那一条。
    const onDisk = readDisk(dir)
    assert.deepEqual(onDisk.map((record) => record.idempotencyKey), ['k1'], '被拒绝的写入不能留下任何痕迹')

    // a 继续写仍然正常：检查只针对外部写者，不能误伤自己。
    a.append(touch('k3'))
    const seqs = readDisk(dir).map((record) => record.seq)
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(seqs[i]! > seqs[i - 1]!, `序号必须严格递增，实际：${seqs.join(',')}`)
    }
    a.close()
    b.close()
  })

  it('两个实例写同一幂等键时只能落盘一条（FR-A2，第二个写者被拒绝）', () => {
    const dir = tempDir()
    const a = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    const b = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    a.open()
    b.open()
    const first = a.append(touch('SAME'))
    assert.equal(first.appended, true)
    // 幂等是跨进程语义：同一事件被两个进程处理，只能留一条。
    // 修复前这里是「b 也写成功 → 磁盘两条」；修复后 b 直接拒绝。
    assertConcurrentWriter(() => b.append(touch('SAME')), 'b 写同一幂等键')
    assert.equal(readDisk(dir).length, 1, '同一幂等键只能落盘一条')
    a.close()
    b.close()
  })

  it('两个实例写不同分片时重放顺序必须与真实写入顺序一致（ST-1，第二个写者被拒绝）', () => {
    const dir = tempDir()
    // 片调到极小，让写入快速滚动分片——这是顺序倒置的触发条件。
    const a = new Journal({ dir, segmentBytes: 200, fsyncOnWrite: false, mode: 'write' })
    const b = new Journal({ dir, segmentBytes: 200, fsyncOnWrite: false, mode: 'write' })
    a.open()
    b.open()
    a.append(touch('first'))
    for (let i = 0; i < 6; i += 1) a.append(touch(`pad-${i}`))
    // 修复前：b 的内存水位停在很靠前的位置，它会把新记录写进**较早的分片**，
    // 于是真实最后写入的记录重放在第 1 位。现在它必须被拒绝。
    assertConcurrentWriter(() => b.append(touch('last')), 'b 滚动了新分片后写入')
    a.close()
    b.close()
    // 重放只按「分片序号 + 行序」，所以磁盘顺序必须与真实写入顺序一致。
    const reader = new Journal({ dir, segmentBytes: 200, fsyncOnWrite: false, mode: 'write' })
    reader.open()
    const replayed = reader.readAll().map((record) => record.idempotencyKey)
    reader.close()
    assert.deepEqual(
      replayed, ['first', 'pad-0', 'pad-1', 'pad-2', 'pad-3', 'pad-4', 'pad-5'],
      `重放顺序必须与写入顺序一致，实际：${replayed.join(',')}`,
    )
  })

  it('只比字节数不够：外部多出一个空分片也必须被拒（分片序号比较单独守）', () => {
    // 这条用例是为反向验证 M2 补的：把 assertSoleWriter 的条件改成只比 diskBytes
    // 之后，原有 5 条用例**一条都没红**——序号那一半从来没被单独验过。
    //
    // 构造的状态：内存水位 index=1 / bytes=0，磁盘末片 index=2 / bytes=0。
    // 两个字段只有一个不同，且不同的那个是**序号**。若实现只比字节数，
    // 这里会放行；放行的后果是两个写者从不同水位各自分配 seq（ST-1 破坏）。
    const dir = tempDir()
    writeFileSync(join(dir, shardFileName(1)), '')
    const b = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    b.open()
    // 前提：b 的内存水位必须真的是 index=1 / 0 字节，否则这条测试测的是别的东西。
    assert.deepEqual(listShardFiles(dir), [shardFileName(1)], '前提：打开时只有分片 1')
    // 外部再建一个**空**分片 2：字节数不变（都是 0），只有序号变了。
    writeFileSync(join(dir, shardFileName(2)), '')
    const error = assertConcurrentWriter(() => b.append(touch('after-empty-shard')), '外部多出空分片后写入')
    b.close()
    // 断言指向「序号不同」这个具体成因，而不是任何并发错误都能让它绿。
    assert.match(error.message, /分片数 2/u, '错误信息必须报出磁盘实际分片数 2')
    assert.match(error.message, /分片数 1/u, '错误信息必须报出内存水位分片数 1')
    // 末片字节数两方都是 0——正是「只比字节数会漏」的那个证据。
    assert.match(error.message, /末片 0 字节/u, '前提：两方末片字节数都是 0，只比字节数必然放行')
  })

  it('错误信息必须说清成因、恢复办法与长期方案', () => {
    const dir = tempDir()
    const a = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    const b = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    a.open()
    b.open()
    a.append(touch('k1'))
    const error = assertConcurrentWriter(() => b.append(touch('k2')), 'b 落后时写入')
    a.close()
    b.close()

    // 错误文案是承诺，不是装饰：用户照着它做必须真的能恢复。
    // 所以「怎么恢复」这一条不能只写「关闭并重开」，还得保证重开是对的
    // ——配套用例见「重开后水位不应翻倍」。
    assert.match(error.message, /第二个写入者/u, '必须说明发生了什么')
    assert.match(error.message, /关闭并重新打开/u, '必须给出恢复办法')
    assert.match(error.message, /长期方案/u, '必须给出长期方案')
    assert.match(error.message, /不要同时运行/u, '长期方案必须点明「不要同时运行」')
    assert.ok(error.message.includes(dir), '必须带上出问题的记忆库绝对路径，否则用户不知道该处理哪个库')
  })

  it('重开后水位不应翻倍（恢复办法必须真的有效）', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    journal.open()
    for (let i = 0; i < 5; i += 1) journal.append(touch(`k${i}`))
    assert.equal(journal.count(), 5, '前提：写入了 5 条')
    assert.equal(journal.lastSeq(), 5, '前提：序号水位到 5')

    // 先证明磁盘上确实有 5 条可解码记录。没有这一步，下面「重开仍是 5」
    // 可能是因为一条都没解出来（open 里的累加循环跑了但全 continue），
    // 那样这条用例就绿在「什么都没发生」上。
    assert.equal(readDisk(dir).length, 5, '前提：磁盘上有 5 条可解码记录')

    journal.close()
    journal.open()
    assert.equal(journal.count(), 5, '重开后条数不应翻倍')
    assert.equal(journal.lastSeq(), 5, '重开后序号水位不应翻倍')

    journal.close()
    journal.open()
    assert.equal(journal.count(), 5, '多次重开也不应累加')
    journal.close()
  })
})

/**
 * 打开模式三态。
 *
 * `rebuild` 必须能截断残缺尾行（那是它的职责），但绝不能追加记录；
 * `query` / `health` 连截断都不该做——一个查一眼的命令顺手改盘，事后无从解释。
 */
describe('打开模式三态', () => {
  /** 造一条最小记录。 */
  function touch(key: string, at = 1_700_000_000_000): JournalRecord {
    return { v: 1, seq: 0, at, idempotencyKey: key, op: { op: 'touch', id: key, at, strength: 0.5 } }
  }

  /** 写入 n 条完整记录，再追加半个残缺行，返回目录。 */
  function seedWithBrokenTail(n = 2): string {
    const dir = tempDir()
    const writer = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write' })
    writer.open()
    for (let i = 0; i < n; i += 1) writer.append(touch(`k${i}`))
    writer.close()
    const path = join(dir, shardFileName(1))
    appendFileSync(path, '{"v":1,"seq":99,"at":1,"idemp', 'utf8')
    return dir
  }

  it('纯只读模式不应截断残缺尾行', () => {
    const dir = seedWithBrokenTail()
    const path = join(dir, shardFileName(1))
    const before = readFileSync(path, 'utf8')
    assert.ok(!before.endsWith('\n'), '前提：尾行必须是残缺的，否则这条用例测不到东西')

    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'readonly' })
    journal.open()
    journal.readAll()
    journal.close()

    // 只读命令查一眼就改盘，在事后审计里无法解释——所以必须逐字节不变。
    assert.equal(readFileSync(path, 'utf8'), before, '纯只读模式不能改动磁盘')
  })

  it('修复性只读模式应截断残缺尾行', () => {
    const dir = seedWithBrokenTail()
    const path = join(dir, shardFileName(1))
    assert.ok(!readFileSync(path, 'utf8').endsWith('\n'), '前提：尾行必须是残缺的')

    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'repair' })
    journal.open()
    journal.close()

    // 与上一条配对：证明「repair 会截断」不是空话，两个模式真的有差别。
    assert.ok(readFileSync(path, 'utf8').endsWith('\n'), '修复性只读模式必须截断残缺尾行')
  })

  it('只读与修复模式下追加记录应被拒绝，且不落盘', () => {
    for (const mode of ['readonly', 'repair'] as const) {
      const dir = seedWithBrokenTail(1)
      const path = join(dir, shardFileName(1))
      const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode })
      journal.open()
      const before = readFileSync(path, 'utf8')
      assert.throws(
        () => journal.append(touch('nope')),
        (error: unknown) => error instanceof ReadOnlyModeError && error.code === 'MEMORY_READONLY_MODE',
        `${mode} 模式下追加应抛 ReadOnlyModeError`,
      )
      // 断言「拒绝」还不够：必须证明磁盘没被写。
      assert.equal(readFileSync(path, 'utf8'), before, `${mode} 模式下被拒绝的写入不能落盘`)
      journal.close()
    }
  })
})
